import { appendFileSync, createReadStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import sirv from "sirv";
import { WebSocketServer } from "ws";
import { createAuthMiddleware, parseCookies, tokensEqual } from "./auth.ts";
import { handleChatEvents } from "./src/api/chat-events.ts";
import { handleChatSubmit } from "./src/api/chat-submit.ts";
import { stopBranchStatusPoller } from "./src/lib/branch-status-poller.ts";
import { isDesktopHostConnected } from "./src/lib/browser-host.ts";
import { listBrowsers } from "./src/lib/browser-manager.ts";
import { handleCdpConnection } from "./src/lib/cdp-proxy.ts";
import { captureSnapshot } from "./src/lib/cdp-targets.ts";
import { startCronjobScheduler, stopCronjobScheduler } from "./src/lib/cronjob-scheduler.ts";
import { closeDb } from "./src/lib/db/connection.ts";
import { runMigrations } from "./src/lib/db/migrate.ts";
import { killAllServers } from "./src/lib/lsp-manager.ts";
import { handleLspConnection } from "./src/lib/lsp-proxy.ts";
import { mimeTypeFromFilename } from "./src/lib/mime-types.ts";
import { listenWithFallback } from "./src/lib/port-utils.ts";
import { checkPrereqs } from "./src/lib/process-utils.ts";
import { runFirstTimeSetup } from "./src/lib/setup.ts";
import { bandHome, getOrCreateToken, loadSettings, resetAgentStatuses } from "./src/lib/state.ts";
import {
  cleanupStaleTasks,
  startTaskPruneScheduler,
  stopTaskPruneScheduler,
} from "./src/lib/task-store.ts";
import { killAllTerminals } from "./src/lib/terminal-manager.ts";
import { handleTerminalConnection } from "./src/lib/terminal-ws.ts";
import { startTunnel, stopTunnel } from "./src/lib/tunnel.ts";
import { resolveWorkspace } from "./src/lib/workspace.ts";
import { handleMcpRequest } from "./src/mcp/server.ts";
import { createContext } from "./src/trpc/context.ts";
import { getScalarHtml } from "./src/trpc/openapi.ts";
import { appRouter } from "./src/trpc/router.ts";

// ---------------------------------------------------------------------------
// Crash handlers — log to file since stdout/stderr may be piped to a log file
// that is only readable after the process exits.
// ---------------------------------------------------------------------------

function logCrash(message: string): void {
  try {
    mkdirSync(bandHome(), { recursive: true });
    appendFileSync(join(bandHome(), "server.log"), message, "utf-8");
  } catch {
    // Best-effort logging — nothing we can do if this fails
  }
}

process.on("unhandledRejection", (reason: unknown) => {
  const timestamp = new Date().toISOString();
  const error = reason instanceof Error ? reason.stack || reason.message : String(reason);
  const payload = `[${timestamp}] Unhandled rejection:\n${error}\n\n`;
  logCrash(payload);
  // Always echo to stderr too. The DMG case pipes stderr to a log file
  // (so this is a duplicate write there), but the dev case
  // (`pnpm dev:web`) leaves the terminal as the only place a developer
  // sees the failure — without this echo, a crash before `listen()`
  // (e.g. `EADDRINUSE` when the Band desktop app already owns 3456)
  // showed nothing in the terminal and the developer had to spelunk
  // `~/.band/server.log` to find out why.
  process.stderr.write(payload);

  // Don't crash the server for known recoverable SDK transport errors.
  // The Claude Code SDK can throw "ProcessTransport is not ready for writing"
  // when a canUseTool callback times out after the agent process has exited.
  if (reason instanceof Error && reason.message.includes("ProcessTransport is not ready")) {
    console.error(`[${timestamp}] Recoverable SDK transport error (not crashing):`, reason.message);
    return;
  }
  process.exit(1);
});

process.on("uncaughtException", (error: Error) => {
  const timestamp = new Date().toISOString();
  const payload = `[${timestamp}] Uncaught exception:\n${error.stack || error.message}\n\n`;
  logCrash(payload);
  // Echo to stderr — see comment in the `unhandledRejection` handler
  // above. `EADDRINUSE` surfaces here as a raw `listen` error and is
  // the most common dev-mode silent failure we see.
  process.stderr.write(payload);
  process.exit(1);
});

// After bundling, this file lives at dist/start-server.mjs in production —
// so paths under `import.meta.dirname` resolve relative to dist/. In dev
// (`tsx watch start-server.ts`) `import.meta.dirname` points at `apps/web/`,
// which is the same path Vite uses as its `root` below.
const SERVER_ROOT = import.meta.dirname;
const clientDir = join(SERVER_ROOT, "client");

// Three-step resolution for the initial port the server will TRY to bind:
//
//   1. `process.env.PORT`      — explicit per-invocation override (used
//                                 by the desktop shell, tests, and
//                                 `PORT=… pnpm dev:web`).
//   2. `settings.json` →
//      `webServerPort`         — persisted user preference.
//   3. Hardcoded `3456`        — historical default; the dev-desktop
//                                 orchestrator and the desktop shell
//                                 both look here when nothing else is
//                                 set.
//
// Whatever value wins is just the *starting* port. `listenWithFallback`
// inside `main()` then scans upwards from there until it finds a free
// one, so a running Band desktop app on 3456 no longer wedges
// `pnpm dev:web` with a silent `EADDRINUSE`.
function resolveInitialPort(): number {
  const fromEnv = Number.parseInt(process.env.PORT ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const settings = loadSettings() as { webServerPort?: unknown };
    if (typeof settings.webServerPort === "number" && settings.webServerPort > 0) {
      return settings.webServerPort;
    }
  } catch {
    // Settings file missing or unreadable on a fresh install — fall
    // through to the default. `getOrCreateToken()` below will create
    // the file on first boot anyway.
  }
  return 3456;
}

const initialPort = resolveInitialPort();
// Remove PORT so child processes don't inherit it (issue #269).
// `BAND_PORT` is set inside `main()` once `listenWithFallback` knows
// which port actually got claimed — the value here was just a hint.
delete process.env.PORT;

// Scrub `ELECTRON_RUN_AS_NODE` from `process.env` once at boot — see
// issue #406. The desktop shell spawns this web server via Electron's
// embedded Node by setting `ELECTRON_RUN_AS_NODE=1`
// (apps/desktop/src/main/services/web-server.ts). Without this scrub
// the var leaks into every child the web server forks and every
// grandchild of those forks. Today most of our spawns target
// non-Electron binaries (rust `band`, `git`, `claude`, Codex) which
// ignore the var, but as soon as we spawn an Electron binary anywhere
// in the tree — `code` from VS Code, a packaged MCP server, the dev
// `pnpm dev:desktop` workflow that hosts its own Electron — that
// child silently runs as plain Node, leaves `app` / `BrowserWindow`
// undefined, and crashes with a confusing CJS-from-ESM NPE in Node's
// loader. Scrubbing once here caps the blast radius at one location
// instead of relying on every future spawn site to remember.
delete process.env.ELECTRON_RUN_AS_NODE;

// In dev mode (`pnpm dev:web` → `tsx watch start-server.ts`) we still call
// `getOrCreateToken()` so any tooling that watches `settings.json` for a
// token sees one, but we pass `undefined` to `createAuthMiddleware` so the
// local browser (or `pnpm dev:desktop`'s Electron shell) can hit the server
// without a cookie. This matches the prior `vite dev` behaviour exactly —
// the deleted `trpcDevPlugin` never added auth either. Production (`node
// dist/start-server.mjs`) enforces the cookie as before.
const isDev = process.env.NODE_ENV === "development";
const persistedToken = getOrCreateToken();
const { handleAuth, expectedToken } = createAuthMiddleware(isDev ? undefined : persistedToken);

// `sirv` calls `totalist` (which calls `readdirSync`) eagerly at construction
// time to build its asset map. The dev server runs from source where
// `dist/client` doesn't exist, so we initialise the prod static handler
// lazily inside `main()` and leave this `null` in dev. The Vite middleware
// chain replaces sirv's role in that mode.
type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;
let assets: StaticHandler | null = null;

// OpenAPI spec.
//
// In prod the spec is pre-generated at build time by @trpc/openapi's CLI
// (see `scripts/build-server.sh`) and read from disk on first hit — fast,
// synchronous. In dev there's no build output, so we run the static
// analyser against the live router source. Both paths add `servers: [{
// url: "/trpc" }]` so Scalar shows the correct URLs, and both cache the
// result for the lifetime of the process.
//
// The cache is a `Promise<string>` rather than a `string` so concurrent
// requests during the (slow) first generation share the same in-flight
// work instead of running the analyser N times. On rejection we null
// the slot back out so the next request gets a fresh attempt — otherwise
// one transient analyser error would pin `/api/openapi.json` to 500 for
// the rest of the process's lifetime. Dev mode also wires up a Vite
// watcher (after `viteServer` is created in `main()`) that nulls the
// slot when a tRPC source file changes, matching the deleted
// `trpcDevPlugin`'s behaviour.
let _openApiSpec: Promise<string> | null = null;
function getOpenApiSpec(): Promise<string> {
  if (_openApiSpec !== null) return _openApiSpec;
  const pending = (async () => {
    if (isDev) {
      // Dynamic import so `@trpc/openapi` doesn't have to be reachable
      // in the prod bundle, where it's external.
      // biome-ignore lint/suspicious/noExplicitAny: untyped runtime import
      const { generateOpenAPIDocument } = (await import("@trpc/openapi")) as any;
      // Resolve the router path against this file's own directory rather
      // than `process.cwd()` so running `tsx apps/web/start-server.ts`
      // from the repo root still finds the source.
      const doc = await generateOpenAPIDocument(join(SERVER_ROOT, "src", "trpc", "router.ts"), {
        title: "Band API",
        version: "1.0.0",
      });
      doc.servers = [{ url: "/trpc" }];
      return JSON.stringify(doc, null, 2);
    }
    const openApiDoc = JSON.parse(readFileSync(join(SERVER_ROOT, "openapi.json"), "utf-8"));
    openApiDoc.servers = [{ url: "/trpc" }];
    return JSON.stringify(openApiDoc, null, 2);
  })().catch((err) => {
    // Don't permanently cache a rejection — clear the slot so the next
    // request retries instead of inheriting the same dead Promise.
    if (_openApiSpec === pending) _openApiSpec = null;
    throw err;
  });
  _openApiSpec = pending;
  return _openApiSpec;
}

let _scalarHtml: string | null = null;
function getCachedScalarHtml(): string {
  if (_scalarHtml !== null) return _scalarHtml;
  _scalarHtml = getScalarHtml("/api/openapi.json");
  return _scalarHtml;
}

/**
 * Serve a file from a subdirectory of a root path.
 * Prevents path traversal and streams the file with the correct MIME type.
 */
function serveStaticFile(
  res: ServerResponse,
  root: string,
  subdir: string,
  rawFilename: string,
): void {
  const filename = basename(decodeURIComponent(rawFilename));
  if (!filename || filename.includes("..")) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  const filePath = join(root, subdir, filename);
  try {
    const fileStat = statSync(filePath);
    const contentType = mimeTypeFromFilename(filename);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": fileStat.size.toString(),
      "Cache-Control": "private, max-age=86400",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

/**
 * Serve a file from a workspace by workspaceId and nested file path.
 * Used for binary file previews (images, PDFs) in the file viewer.
 */
function serveWorkspaceFile(res: ServerResponse, workspaceId: string, rawPath: string): void {
  const workspace = resolveWorkspace(workspaceId);
  if (!workspace) {
    res.writeHead(404);
    res.end("Workspace not found");
    return;
  }

  const root = workspace.worktree.path;
  const target = resolve(join(root, rawPath));

  // Path traversal protection: target must be within workspace root
  if (!target.startsWith(`${root}/`) && target !== root) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  try {
    const fileStat = statSync(target);
    const contentType = mimeTypeFromFilename(basename(target));
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": fileStat.size.toString(),
      "Cache-Control": "private, no-cache",
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ---------------------------------------------------------------------------
// Node IncomingMessage ↔ Web Request adapters.
//
// Both the unified Vite-middleware fallback path and the prod sirv fallback
// path need to hand a `Request` to the TanStack `server-entry` `fetch`
// adapter, so factor the conversion out instead of duplicating it.
// ---------------------------------------------------------------------------

async function nodeRequestToWeb(req: IncomingMessage): Promise<Request> {
  // `Host` is optional in HTTP/1.0 — without the fallback `new URL(...,
  // "http://undefined")` would yield a bogus base. Default to localhost
  // since this server is intended for local / internal use; the actual
  // host doesn't matter for the SSR + tRPC paths that read the URL.
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url!, `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }
  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Buffer the request body in memory before handing it to TanStack /
    // tRPC as a Web Request. Cap at 100 MB — well above any tRPC mutation,
    // SSR form post, or MCP request we serve, but enough headroom that a
    // legitimate large /api/uploads PUT (if one ever gets routed here)
    // doesn't surprise the user. Without a cap, a malformed POST or a
    // slowloris-style upload could OOM the whole process.
    const MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024;
    body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytesSoFar = 0;
      req.on("data", (chunk: Buffer) => {
        bytesSoFar += chunk.byteLength;
        if (bytesSoFar > MAX_REQUEST_BODY_BYTES) {
          reject(Object.assign(new Error("Request body too large"), { code: "BODY_TOO_LARGE" }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }
  return new Request(url.toString(), {
    method: req.method,
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

function pipeWebResponseToNodeRes(response: Response, res: ServerResponse): void {
  // Preserve multi-value headers (notably `Set-Cookie`). `Headers.entries()`
  // emits the same key multiple times when a multi-value header is present,
  // and `Object.fromEntries` would collapse duplicates to the last value
  // only — silently dropping auth/analytics cookie pairs on SSR responses.
  // `writeHead` accepts `string[]` values for these, so accumulate them.
  const headersOut: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    const existing = headersOut[key];
    if (existing === undefined) {
      headersOut[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      headersOut[key] = [existing, value];
    }
  });
  res.writeHead(response.status, headersOut);
  if (response.body) {
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        // Honour backpressure: `res.write` returns `false` when the
        // socket's internal buffer hits its high water mark. Without
        // awaiting `drain` here, large SSR payloads or long-running
        // tRPC streams would accumulate unbounded in Node's buffer,
        // blowing memory on slow clients. The error leg is essential
        // for long-lived streams (tRPC subs, SSE): without it, a
        // client that disconnects mid-stream leaves the drain Promise
        // unresolved and the pump task leaked.
        if (!res.write(value)) {
          // Cross-remove the partner listener whichever fires first.
          // `once()` clears itself but not its sibling, so a slow client
          // with many write-backpressure cycles would otherwise leak
          // unfired `error` (or `drain`) listeners — and trip Node's
          // MaxListeners warning after ~10 cycles.
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              res.removeListener("error", onError);
              resolve();
            };
            const onError = (err: Error) => {
              res.removeListener("drain", onDrain);
              reject(err);
            };
            res.once("drain", onDrain);
            res.once("error", onError);
          });
        }
      }
    };
    pump().catch((err) => {
      // Surface stream failures so a truncated SSR / tRPC stream
      // doesn't fail silently — without this the client sees a
      // half-written response and the logs have no trace of why.
      console.error("Stream pump error:", err);
      try {
        res.end();
      } catch {
        // Socket already closed — nothing to do.
      }
    });
  } else {
    // `.catch` so a body-read failure (or already-consumed Response)
    // doesn't bubble to the global `unhandledRejection` handler — that
    // handler exits the process, so an SSR response with a closed
    // socket would otherwise recycle the entire server.
    response.text().then(
      (text) => res.end(text),
      () => {
        if (!res.headersSent) res.writeHead(500);
        try {
          res.end();
        } catch {
          // Socket already closed.
        }
      },
    );
  }
}

async function main() {
  // -----------------------------------------------------------------------
  // Phase A — work that MUST complete before we accept the first request.
  //
  // The cardinal rule: if absence of this step would corrupt state on the
  // first request, it goes here. Everything else is deferred to Phase B
  // (after `listen()`) via `setImmediate` so the user-visible "server is
  // up" event isn't held back by background bookkeeping.
  //
  // Today the only blocker is the DB schema migration. Hydration
  // (`loadChatsFromDb`, `loadBrowsersFromDb`) is intentionally lazy —
  // both managers run the same code path the first time their public API
  // is hit via `ensureInitialized()`, so deferring it costs nothing on a
  // cold cache and saves the boot path one synchronous SQL pass.
  // -----------------------------------------------------------------------
  runMigrations();

  // -----------------------------------------------------------------------
  // Dev vs prod renderer transport.
  //
  // In dev (`pnpm dev:web`) we mount Vite as middleware *inside* our own
  // http server. Vite handles route HMR, asset transformation, and SSR
  // module loading; we own everything else (auth, /trpc, /mcp, /api/*,
  // WebSocket upgrades). The `ssrLoadModule("@tanstack/react-start/
  // server-entry")` path returns the live re-evaluated module on every
  // request, so edits to `__root.tsx` and friends show up on the next
  // navigation without a process restart.
  //
  // In prod (`node dist/start-server.mjs`) Vite isn't installed in the
  // dependency closure — the bundle uses `sirv` for hashed asset serving
  // plus a single eager import of the prebuilt SSR bundle.
  //
  // Both branches end up calling the same `serverEntryHandler(request)`
  // contract: `(Request) => Promise<Response>`. The SSR fallback below
  // doesn't know which branch produced it.
  // -----------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: vite is dev-only, no runtime types in prod
  let viteServer: any = null;
  let viteMiddlewares:
    | ((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void)
    | null = null;
  let serverEntryHandler: (req: Request) => Promise<Response>;

  // Create the http server early in both modes so we can pass it to Vite
  // as the HMR ws host below. The request handler is a closure that
  // refers to `viteMiddlewares` / `serverEntryHandler` by name; both
  // assignments complete before we call `listen()`, so the closure never
  // sees a half-initialised state.
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res).catch((err) => {
      // Any uncaught error inside the async handler chain (most often a
      // missing static asset like `dist/openapi.json` or a tRPC-layer
      // throw) would otherwise bubble to the global
      // `unhandledRejection` handler and kill the whole server. Catch
      // it here, log, and reply with an appropriate status so a single
      // bad request can't recycle the process.
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      // Surface a proper 413 for oversized request bodies so callers
      // get the standard "Content Too Large" signal instead of an
      // opaque 500.
      const isTooLarge = code === "BODY_TOO_LARGE";
      if (!isTooLarge) console.error("Request handler error:", message);
      if (!res.headersSent) {
        if (isTooLarge) {
          res.writeHead(413, { "Content-Type": "text/plain" });
        } else {
          res.writeHead(500, { "Content-Type": "text/plain" });
        }
      }
      try {
        res.end(isTooLarge ? "Request body too large" : "Internal server error");
      } catch {
        // Socket already closed — nothing to do.
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Dev-mode liveness check. In prod `/api/health` is auth-protected
    // (and answered inside `handleAuth`); in dev there is no token so
    // `handleAuth` returns early and the request would otherwise fall
    // through to SSR. The desktop shell and the dev-mode integration
    // tests both rely on `/api/health` as the "server is up" probe in
    // either mode, so we answer it unconditionally before auth here.
    // Hostname is omitted to match the shape callers parse — they only
    // look at `status` and `app`.
    // Strip the query string before matching so probes that tack on
    // cache-busters (`/api/health?_=1234`) still hit this branch.
    if (isDev && req.url?.split("?")[0] === "/api/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", app: "band-web-server" }));
      return;
    }

    // Auth check runs first (no-op in dev when no token is configured)
    if (handleAuth(req, res)) return;

    // Serve uploaded files (images, attachments)
    if (req.url?.startsWith("/api/uploads/")) {
      serveStaticFile(res, bandHome(), "uploads", req.url.slice("/api/uploads/".length));
      return;
    }

    // Serve agent-shared files — URL: /api/shared/<workspaceId>/<filename>
    if (req.url?.startsWith("/api/shared/")) {
      const rest = req.url.slice("/api/shared/".length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx === -1) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      const partition = basename(decodeURIComponent(rest.slice(0, slashIdx)));
      if (!partition || partition === ".." || partition === ".") {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      serveStaticFile(res, bandHome(), join("shared", partition), rest.slice(slashIdx + 1));
      return;
    }

    // Serve workspace files (images, PDFs, etc.) — URL: /api/workspace-file/<workspaceId>/<path...>
    if (req.url?.startsWith("/api/workspace-file/")) {
      const rest = req.url.slice("/api/workspace-file/".length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx === -1) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      const wId = decodeURIComponent(rest.slice(0, slashIdx));
      const filePath = rest.slice(slashIdx + 1);
      if (!wId || !filePath) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      serveWorkspaceFile(res, wId, decodeURIComponent(filePath));
      return;
    }

    // CDP screencast experiment: list Band browser tabs (DB-backed) for
    // a workspace. The web client renders one dockview panel per tab and
    // streams via /cdp?bandTabId=<id> when the user picks one.
    if (req.url?.startsWith("/api/cdp/tabs")) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const workspaceId = url.searchParams.get("workspaceId");
      if (!workspaceId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tabs: [], error: "Missing workspaceId" }));
        return;
      }
      const tabs = listBrowsers(workspaceId).map((b) => ({
        id: b.id,
        url: b.url,
        title: b.name,
      }));
      const desktopConnected = isDesktopHostConnected();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      });
      res.end(
        JSON.stringify({
          tabs,
          // Surface "open the desktop app" UX when no desktop is subscribed.
          error: desktopConnected
            ? null
            : "Open the Band desktop app on this machine to use the Browser pane.",
        }),
      );
      return;
    }

    // CDP screencast experiment: snapshot a single Band browser tab as JPEG.
    // URL: /api/cdp/snapshot/<bandTabId>
    const cdpSnapshotMatch = req.url?.match(/^\/api\/cdp\/snapshot\/([^/?]+)/);
    if (cdpSnapshotMatch) {
      const bandTabId = decodeURIComponent(cdpSnapshotMatch[1]);
      try {
        const jpeg = await captureSnapshot(bandTabId);
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": jpeg.length.toString(),
          "Cache-Control": "no-cache",
        });
        res.end(jpeg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(502, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-cache",
        });
        res.end(message);
      }
      return;
    }

    // Serve OpenAPI spec
    if (req.url === "/api/openapi.json") {
      const spec = await getOpenApiSpec();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(spec);
      return;
    }

    // Serve Scalar API docs UI
    if (req.url === "/api/docs") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache",
      });
      res.end(getCachedScalarHtml());
      return;
    }

    // Handle MCP (Model Context Protocol) requests
    if (req.url?.startsWith("/mcp")) {
      await handleMcpRequest(req, res);
      return;
    }

    // Chat events stream — single subscription that replays history + tails
    // live broadcasts for one chat. Replaced the legacy `/api/tasks/.../stream`
    // SSE endpoint as part of the chat-event-log refactor. See
    // `apps/web/src/api/chat-events.ts` and `docs/experiments/chat-event-log.md`.
    const chatEventsMatch = req.url?.match(/^\/api\/chats\/([^/]+)\/events(?:\?|$)/);
    if (chatEventsMatch && req.method === "GET") {
      void handleChatEvents(req, res, decodeURIComponent(chatEventsMatch[1])).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        } else {
          try {
            res.end();
          } catch {
            // already torn down
          }
        }
        console.error("[chat-events] handler error", err);
      });
      return;
    }

    // Decoupled submit endpoint — sister of /events. Returns 200 immediately
    // (no SSE body); subscribers see the server's response over /events.
    const chatSubmitMatch = req.url?.match(/^\/api\/chats\/([^/]+)\/messages(?:\?|$)/);
    if (chatSubmitMatch && req.method === "POST") {
      void handleChatSubmit(req, res, decodeURIComponent(chatSubmitMatch[1])).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
        console.error("[chat-submit] handler error", err);
      });
      return;
    }

    // Handle tRPC requests before TanStack router. We construct the Web
    // Request once here so it's shared between the tRPC and SSR branches
    // — the body has already been buffered by `nodeRequestToWeb`, so the
    // second handler doesn't have to re-read the stream.
    if (req.url?.startsWith("/trpc")) {
      const request = await nodeRequestToWeb(req);
      const response = await fetchRequestHandler({
        endpoint: "/trpc",
        req: request,
        router: appRouter,
        createContext,
      });
      pipeWebResponseToNodeRes(response, res);
      return;
    }

    // -----------------------------------------------------------------------
    // Renderer transport.
    //
    // In dev, Vite's middleware chain handles static assets, source
    // transforms, and HMR client injection — anything it doesn't claim
    // falls through to our SSR fallback. In prod, `sirv` handles hashed
    // immutable assets and falls through to SSR for SPA-style routes.
    // Either way, the fallback calls the unified `serverEntryHandler`.
    // -----------------------------------------------------------------------
    const ssrFallback = async () => {
      try {
        const request = await nodeRequestToWeb(req);
        const response = await serverEntryHandler(request);
        pipeWebResponseToNodeRes(response, res);
      } catch (err) {
        if (isDev && viteServer) {
          // Surface the source location of the SSR error via Vite's
          // sourcemap-aware fixer — otherwise the stack points into the
          // transformed module, which is unreadable.
          viteServer.ssrFixStacktrace?.(err);
        }
        console.error("SSR error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
        }
        res.end("Internal server error");
      }
    };

    if (viteMiddlewares) {
      viteMiddlewares(req, res, ssrFallback);
      return;
    }
    // In prod `assets` is set inside `main()` before we accept the first
    // request, so the non-null assertion is structural; in dev we take
    // the branch above.
    assets!(req, res, ssrFallback);
  }

  // -----------------------------------------------------------------------
  // Wire up the renderer transport (Vite-as-middleware in dev, sirv +
  // prebuilt SSR bundle in prod). Done AFTER `createServer()` so we can
  // hand the http server to Vite's `hmr.server` option — that lets
  // Vite's HMR WebSocket ride on our listener via the `vite-hmr`
  // subprotocol, with our own `httpServer.on("upgrade", …)` handler
  // short-circuiting on that protocol so the two listeners don't fight
  // over the upgrade.
  // -----------------------------------------------------------------------
  if (isDev) {
    // biome-ignore lint/suspicious/noExplicitAny: vite is a devDep, imported dynamically so prod bundle skips it
    const { createServer: createViteServer } = (await import("vite")) as any;
    viteServer = await createViteServer({
      root: SERVER_ROOT,
      appType: "custom",
      // Plugins, define, resolve.alias, and ssr config all live in
      // `vite.config.ts` and are picked up automatically — the file is
      // resolved from `root` by Vite. We override `server` here so the
      // config's defaults don't try to spin up Vite's own http listener.
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
    });
    viteMiddlewares = viteServer.middlewares;
    serverEntryHandler = async (request: Request) => {
      // biome-ignore lint/suspicious/noExplicitAny: ssrLoadModule returns untyped modules
      const mod: any = await viteServer.ssrLoadModule("@tanstack/react-start/server-entry");
      return mod.default.fetch(request);
    };
    // Invalidate the cached OpenAPI spec whenever a file under
    // `src/trpc/` changes, so `/api/openapi.json` reflects router
    // edits during a dev session without a server restart. Mirrors the
    // `server.watcher.on("change")` hook the deleted `trpcDevPlugin`
    // used to install — Vite's HMR handles SSR module invalidation
    // separately, but the spec is generated by `@trpc/openapi`'s
    // static analyser, which has its own cache that only this manual
    // reset can reach.
    // Match by absolute prefix so only edits inside *this* package's
    // `src/trpc/` tree invalidate. Pre-fix this used `file.endsWith(
    // "router.ts")` as a fallback, which is over-broad — any
    // `router.ts` elsewhere in the monorepo (e.g.
    // `packages/coding-agent/src/router.ts`) would needlessly null
    // the cache and force a re-analysis of the wrong file.
    const trpcDir = join(SERVER_ROOT, "src", "trpc");
    viteServer.watcher.on("change", (file: string) => {
      if (file.startsWith(trpcDir)) {
        _openApiSpec = null;
      }
    });
  } else {
    assets = sirv(clientDir, {
      maxAge: 31536000,
      immutable: true,
      gzip: true,
      etag: true,
    });
    const mod = await import("./server/server.js");
    const server = mod.default as { fetch: (req: Request) => Promise<Response> };
    serverEntryHandler = (request) => server.fetch(request);
  }

  // ---------------------------------------------------------------------------
  // WebSocket server for tRPC subscriptions
  // ---------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  const wssHandler = applyWSSHandler({ wss, router: appRouter, createContext });

  // ---------------------------------------------------------------------------
  // WebSocket server for terminal connections
  // ---------------------------------------------------------------------------
  const terminalWss = new WebSocketServer({ noServer: true });

  // ---------------------------------------------------------------------------
  // WebSocket server for LSP connections
  // ---------------------------------------------------------------------------
  const lspWss = new WebSocketServer({ noServer: true });

  // ---------------------------------------------------------------------------
  // WebSocket server for CDP screencast proxy (experiment)
  // ---------------------------------------------------------------------------
  const cdpWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    // Vite's HMR WebSocket lives on this same http server in dev mode. It
    // identifies itself with the `vite-hmr` subprotocol — leave that
    // upgrade alone so Vite's own listener (registered when we created
    // the middleware-mode server above) can claim it. Parse the header
    // as a proper comma-separated token list rather than a raw substring
    // match so a client offering e.g. `my-vite-hmr-shim` can't slip past.
    if (
      isDev &&
      req.headers["sec-websocket-protocol"]
        ?.split(",")
        .map((s) => s.trim())
        .includes("vite-hmr")
    ) {
      return;
    }

    // Auth check: validate band_token cookie (skip if no token configured)
    if (expectedToken) {
      const cookies = parseCookies(req);
      if (!tokensEqual(cookies.band_token, expectedToken)) {
        socket.destroy();
        return;
      }
    }

    const url = new URL(req.url!, `http://${req.headers.host}`);

    if (url.pathname === "/lsp") {
      lspWss.handleUpgrade(req, socket, head, (ws) => {
        handleLspConnection(ws, req);
      });
      return;
    }

    if (url.pathname === "/terminal") {
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalConnection(ws, req);
      });
      return;
    }

    if (url.pathname === "/cdp") {
      cdpWss.handleUpgrade(req, socket, head, (ws) => {
        handleCdpConnection(ws, req);
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  // Tracks the still-in-flight Phase B promise (currently just
  // `runFirstTimeSetup` — everything else in Phase B is synchronous).
  // The shutdown handler awaits this with a small timeout so SIGTERM
  // doesn't have to race the `execFile` calls inside
  // `whichBinary`/`shellPath`. Without it, `process.exit(0)` fires
  // quickly but the orphaned child subprocesses (the user's
  // interactive shell loaded with `-li`) kept the test harness's
  // `afterAll` waiting until vitest's 30 s `hookTimeout` killed it.
  //
  // Initialised eagerly to a promise that resolves when the Phase B
  // setImmediate callback assigns the real work — that way SIGTERM
  // delivered in the (sub-millisecond) window between `listen()`
  // returning and the `setImmediate` callback firing still waits
  // correctly, instead of seeing `null` and tearing the DB down
  // before Phase B has even started.
  let phaseBStarted!: () => void;
  const phaseBSettlePromise: Promise<void> = new Promise<void>((resolve) => {
    phaseBStarted = resolve;
  });

  // Bind the http server, scanning upward from `initialPort` until we
  // find a free port. Surfaces a clear error to stderr if every port
  // in the scan range is taken — much friendlier than the silent
  // EADDRINUSE we used to die with.
  let boundPort: number;
  try {
    boundPort = await listenWithFallback(httpServer, initialPort, 20);
  } catch (err) {
    process.stderr.write(
      `\nFailed to bind any port in ${initialPort}..${initialPort + 19}:\n` +
        `  ${(err as Error).message}\n` +
        `→ Quit the process holding these ports (typically the Band desktop app)\n` +
        `  or set PORT to a different value, e.g. PORT=4000 pnpm dev:web\n\n`,
    );
    throw err;
  }
  // Stash the actual bound port for downstream consumers
  // (`src/trpc/router.ts::tunnel.start` reads BAND_PORT to know which
  // port cloudflared should forward to). Set AFTER `listenWithFallback`
  // because the value before then was just a hint, not a guarantee.
  process.env.BAND_PORT = String(boundPort);

  console.log(`Web server listening on http://0.0.0.0:${boundPort}`);
  if (boundPort !== initialPort) {
    console.log(
      `  (started looking at ${initialPort}; ports ${initialPort}..${boundPort - 1} were in use)`,
    );
  }
  // Wall-time from Node process spawn (i.e. the moment the desktop
  // shell or `pnpm start` forked this script) to the moment we're
  // accepting requests. Single grep-able line so #472-style boot
  // optimizations have a clean before/after number to point at;
  // `process.uptime()` is preferred over a module-scope timer
  // because it captures the bundle-load + module-evaluation cost
  // too (the bundled `start-server.mjs` is ~5.5 MB).
  console.log(`Web server boot took ${(process.uptime() * 1000).toFixed(0)} ms`);

  // -----------------------------------------------------------------------
  // Phase B — fire-and-forget bookkeeping that runs AFTER `listen()`.
  //
  // None of these steps gate the first request:
  //   - `cleanupStaleTasks` flips persisted `running` rows to `failed` /
  //     `idle` and runs immediately on the event-loop turn after the
  //     listen callback. Until it does, the worst case is that
  //     `tasks.list` reports a stale row as `running` for a few ms.
  //   - `resetAgentStatuses` is similar — at-most a brief window where
  //     `workspaceStatuses.agentStatus` looks busy.
  //   - `startTaskPruneScheduler` and `startCronjobScheduler` just bind
  //     interval timers; the user can wait the few ms before their
  //     cron fires.
  //   - `runFirstTimeSetup` does file-system bookkeeping (editor
  //     detection, CLI install, hooks). Awaited in the old code path
  //     was costing ~200-500 ms of `listen()` latency for absolutely
  //     no first-request benefit.
  //
  // `setImmediate` (vs. spawning Promises directly) keeps these out of
  // the current macrotask so they don't compete with the http server's
  // own `listening` event handlers.
  // -----------------------------------------------------------------------
  setImmediate(() => {
    // Mark any persisted "running" tasks as "failed" — no agent can be
    // running if the server just started.
    //
    // ORDER MATTERS within Phase B: this must run BEFORE
    // `startTaskPruneScheduler` below. The prune's `completedAt`-branch
    // only matches non-null timestamps; stamping dangling `running`
    // rows with `completedAt = now` here ensures they're evaluated
    // against the cutoff via `completedAt` rather than relying on the
    // fallback to `startedAt`. Swapping these two calls would leave
    // very old in-flight rows wedged in `running` state for one extra
    // boot cycle.
    cleanupStaleTasks();

    // Kick off the periodic task-history sweep (issue #416). Runs one
    // pass immediately, then every 24h, deleting rows older than 30
    // days. The timer is unref()'d so it doesn't block shutdown.
    startTaskPruneScheduler();

    // Reset any "working" agent statuses — no agent is active on a
    // fresh server start.
    const resetCount = resetAgentStatuses();
    if (resetCount > 0) {
      console.log(`Reset ${resetCount} stale agent status(es) on startup`);
    }

    // First-time setup → cron-scheduler binding → tunnel auto-start.
    //
    // Sequential by design: `runFirstTimeSetup` writes default settings
    // (default-disable for cronjobs, notification defaults, etc.) that
    // `startCronjobScheduler`'s first load needs to see. If we kicked
    // them off concurrently — as an earlier iteration of this PR did —
    // newly-installed cronjobs would fire before
    // `runFirstTimeSetup` had a chance to flip them off, causing
    // first-boot users to get spurious cron runs.
    //
    // Tracked on `phaseBSettlePromise` so the SIGTERM/SIGINT handler
    // can wait (bounded) for the chain to settle before tearing the
    // DB and sockets down. Otherwise the `execFile` calls inside
    // `whichBinary`/`shellPath` keep the event loop alive past
    // `process.exit(0)`'s call site.
    // Chain the real work onto the eagerly-allocated
    // `phaseBSettlePromise` so the shutdown handler observes the same
    // promise that's already in the closure rather than a re-assigned
    // one. This also closes the SIGTERM-before-setImmediate-fires
    // window — the shutdown handler waits on the original promise,
    // which only resolves after `phaseBStarted()` fires below.
    (async () => {
      try {
        await runFirstTimeSetup();
      } catch (err) {
        console.error("First-time setup failed:", err);
      }

      // Start cronjob scheduler AFTER setup so any setting tweaks
      // `runFirstTimeSetup` applied (default-disable etc.) are visible
      // to the first scheduled load.
      startCronjobScheduler();

      // Auto-start tunnel if configured.
      const settings = loadSettings() as Record<string, unknown>;
      if (settings.autoStartTunnel) {
        try {
          const prereqs = await checkPrereqs();
          if (prereqs.cloudflared) await startTunnel({ port: boundPort });
        } catch (err) {
          console.error("Failed to auto-start tunnel:", err);
        }
      }
    })().finally(phaseBStarted);
  });

  // Graceful shutdown
  const shutdown = async () => {
    stopBranchStatusPoller();
    stopCronjobScheduler();
    stopTaskPruneScheduler();
    killAllTerminals();
    killAllServers();

    // Wait for any still-in-flight Phase B work to settle so we don't
    // tear down the DB / sockets out from under it. `runFirstTimeSetup`
    // can take 1-3 s on a populated $HOME (skill installer + agent
    // detection via `execFile`), so the timeout needs to be > the
    // documented worst case; 2 s was too tight and could fire before
    // the skill installer's writes finished, leaving the DB closed
    // mid-write. SIGTERM is still responsive enough at 5 s — once the
    // timeout fires we just exit and let Node clean up dangling
    // children.
    // phaseBSettlePromise is always assigned (an eager Promise that
    // resolves either when Phase B finishes or, if SIGTERM beats the
    // `setImmediate` callback, immediately at first `.then`).
    await Promise.race([
      phaseBSettlePromise,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
    ]);

    await stopTunnel().catch(() => {});
    wssHandler.broadcastReconnectNotification();
    wss.close();
    terminalWss.close();
    lspWss.close();
    cdpWss.close();
    httpServer.close();
    if (viteServer) {
      await viteServer.close().catch(() => {});
    }
    closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
