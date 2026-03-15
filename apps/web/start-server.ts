import { appendFileSync, createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import sirv from "sirv";
import { WebSocketServer } from "ws";
import { createAuthMiddleware, parseCookies, tokensEqual } from "./auth.ts";
import { stopBranchStatusPoller } from "./src/lib/branch-status-poller.ts";
import { startCronjobScheduler, stopCronjobScheduler } from "./src/lib/cronjob-scheduler.ts";
import { checkPrereqs } from "./src/lib/process-utils.ts";
import { bandHome, ensureDirs, getOrCreateToken, loadSettings } from "./src/lib/state.ts";
import { closeDb } from "./src/lib/db/connection.ts";
import { runMigrations } from "./src/lib/db/migrate.ts";
import { cleanupStaleTasks } from "./src/lib/task-store.ts";
import { killAllTerminals } from "./src/lib/terminal-manager.ts";
import { handleTerminalConnection } from "./src/lib/terminal-ws.ts";
import { startTunnel, stopTunnel } from "./src/lib/tunnel.ts";
import { createContext } from "./src/trpc/context.ts";
import { appRouter } from "./src/trpc/router.ts";

// ---------------------------------------------------------------------------
// Crash handlers — log to file since stdout/stderr may be piped to a log file
// that is only readable after the process exits.
// ---------------------------------------------------------------------------

function logCrash(message: string): void {
  try {
    ensureDirs();
    appendFileSync(join(bandHome(), "server.log"), message, "utf-8");
  } catch {
    // Best-effort logging — nothing we can do if this fails
  }
}

process.on("unhandledRejection", (reason: unknown) => {
  const timestamp = new Date().toISOString();
  const error = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logCrash(`[${timestamp}] Unhandled rejection:\n${error}\n\n`);
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

const { handleAuth, expectedToken } = createAuthMiddleware(getOrCreateToken());

const assets = sirv(clientDir, {
  maxAge: 31536000,
  immutable: true,
  gzip: true,
  etag: true,
});

async function main() {
  // Run database migrations before anything else
  runMigrations();

  // Mark any persisted "running" tasks as "failed" — no agent can be running
  // if the server just started.
  cleanupStaleTasks();

  // Start cronjob scheduler — reads definitions and watches for changes
  startCronjobScheduler();

  const mod = await import("./server/server.js");
  const server = mod.default as { fetch: (req: Request) => Promise<Response> };

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Auth check runs first
    if (handleAuth(req, res)) return;

    // Serve uploaded files (images, attachments)
    if (req.url?.startsWith("/api/uploads/")) {
      const filename = basename(decodeURIComponent(req.url.slice("/api/uploads/".length)));
      if (!filename || filename.includes("..")) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      const filePath = join(bandHome(), "uploads", filename);
      try {
        const fileStat = statSync(filePath);
        const ext = extname(filename).toLowerCase();
        const mimeTypes: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".pdf": "application/pdf",
          ".json": "application/json",
          ".txt": "text/plain",
          ".md": "text/markdown",
          ".csv": "text/csv",
        };
        const contentType = mimeTypes[ext] || "application/octet-stream";
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
    await stopTunnel().catch(() => {});
    wssHandler.broadcastReconnectNotification();
    wss.close();
    terminalWss.close();
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
