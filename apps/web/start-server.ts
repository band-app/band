import { appendFileSync, createReadStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import sirv from "sirv";
import { WebSocketServer } from "ws";
import { createAuthMiddleware, parseCookies, tokensEqual } from "./auth.ts";
import { stopBranchStatusPoller } from "./src/lib/branch-status-poller.ts";
import { startCronjobScheduler, stopCronjobScheduler } from "./src/lib/cronjob-scheduler.ts";
import { closeDb } from "./src/lib/db/connection.ts";
import { runMigrations } from "./src/lib/db/migrate.ts";
import { killAllServers } from "./src/lib/lsp-manager.ts";
import { handleLspConnection } from "./src/lib/lsp-proxy.ts";
import { mimeTypeFromFilename } from "./src/lib/mime-types.ts";
import { checkPrereqs } from "./src/lib/process-utils.ts";
import { bandHome, getOrCreateToken, loadSettings, resetAgentStatuses } from "./src/lib/state.ts";
import { cleanupStaleTasks } from "./src/lib/task-store.ts";
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
  logCrash(`[${timestamp}] Unhandled rejection:\n${error}\n\n`);

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
  logCrash(`[${timestamp}] Uncaught exception:\n${error.stack || error.message}\n\n`);
  process.exit(1);
});

// After bundling, this file lives at dist/start-server.mjs,
// so paths are relative to dist/.
const clientDir = join(import.meta.dirname, "client");
const port = parseInt(process.env.PORT || "3456", 10);
// Remove PORT so child processes don't inherit it (issue #269).
// Store as BAND_PORT for internal re-reads (e.g. tunnel start).
delete process.env.PORT;
process.env.BAND_PORT = String(port);

const { handleAuth, expectedToken } = createAuthMiddleware(getOrCreateToken());

const assets = sirv(clientDir, {
  maxAge: 31536000,
  immutable: true,
  gzip: true,
  etag: true,
});

// OpenAPI spec is pre-generated at build time by @trpc/openapi CLI.
// Add server base path so docs show correct /trpc/* URLs.
const openApiDoc = JSON.parse(readFileSync(join(import.meta.dirname, "openapi.json"), "utf-8"));
openApiDoc.servers = [{ url: "/trpc" }];
const openApiSpec = JSON.stringify(openApiDoc, null, 2);
const scalarHtml = getScalarHtml("/api/openapi.json");

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

async function main() {
  // Run database migrations before anything else
  runMigrations();

  // Mark any persisted "running" tasks as "failed" — no agent can be running
  // if the server just started.
  cleanupStaleTasks();

  // Reset any "working" agent statuses — no agent is active on a fresh
  // server start.
  const resetCount = resetAgentStatuses();
  if (resetCount > 0) {
    console.log(`Reset ${resetCount} stale agent status(es) on startup`);
  }

  // Start cronjob scheduler — reads definitions and watches for changes
  startCronjobScheduler();

  const mod = await import("./server/server.js");
  const server = mod.default as { fetch: (req: Request) => Promise<Response> };

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Auth check runs first
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

    // Serve OpenAPI spec
    if (req.url === "/api/openapi.json") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(openApiSpec);
      return;
    }

    // Serve Scalar API docs UI
    if (req.url === "/api/docs") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache",
      });
      res.end(scalarHtml);
      return;
    }

    // Handle MCP (Model Context Protocol) requests
    if (req.url?.startsWith("/mcp")) {
      await handleMcpRequest(req, res);
      return;
    }

    // Try serving static assets first (sirv calls next() if no match)
    assets(req, res, async () => {
      const protocol = "http";
      const url = new URL(req.url!, `${protocol}://${req.headers.host}`);

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
        body = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => resolve(Buffer.concat(chunks)));
          req.on("error", reject);
        });
      }

      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body,
        duplex: "half",
      } as RequestInit);

      // Handle tRPC requests before TanStack router
      if (url.pathname.startsWith("/trpc")) {
        const response = await fetchRequestHandler({
          endpoint: "/trpc",
          req: request,
          router: appRouter,
          createContext,
        });

        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

        if (response.body) {
          const reader = response.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                res.end();
                break;
              }
              res.write(value);
            }
          };
          pump().catch(() => res.end());
        } else {
          res.end(await response.text());
        }
        return;
      }

      const response = await server.fetch(request);

      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

      if (response.body) {
        const reader = response.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              break;
            }
            res.write(value);
          }
        };
        pump().catch(() => res.end());
      } else {
        const text = await response.text();
        res.end(text);
      }
    });
  });

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

  httpServer.on("upgrade", (req, socket, head) => {
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

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`Web server listening on http://0.0.0.0:${port}`);

    // Branch status poller is started lazily by the watcher
    // when the first subscriber connects.

    // Auto-start tunnel if configured
    const settings = loadSettings() as Record<string, unknown>;
    if (settings.autoStartTunnel) {
      checkPrereqs()
        .then((prereqs) => {
          if (prereqs.cloudflared) {
            return startTunnel({ port });
          }
        })
        .catch((err) => {
          console.error("Failed to auto-start tunnel:", err);
        });
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    stopBranchStatusPoller();
    stopCronjobScheduler();
    killAllTerminals();
    killAllServers();
    await stopTunnel().catch(() => {});
    wssHandler.broadcastReconnectNotification();
    wss.close();
    terminalWss.close();
    lspWss.close();
    httpServer.close();
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
