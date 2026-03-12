import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import sirv from "sirv";
import { createAuthMiddleware } from "./auth.ts";
import { stopBranchStatusPoller } from "./src/lib/branch-status-poller.ts";
import { startCronjobScheduler, stopCronjobScheduler } from "./src/lib/cronjob-scheduler.ts";
import { checkPrereqs } from "./src/lib/process-utils.ts";
import { getOrCreateToken, loadSettings } from "./src/lib/state.ts";
import { cleanupStaleTasks } from "./src/lib/task-store.ts";
import { startTunnel, stopTunnel } from "./src/lib/tunnel.ts";
import { createContext } from "./src/trpc/context.ts";
import { appRouter } from "./src/trpc/router.ts";

// After bundling, this file lives at dist/start-server.mjs,
// so paths are relative to dist/.
const clientDir = join(import.meta.dirname, "client");
const port = parseInt(process.env.PORT || "3456", 10);

const { handleAuth } = createAuthMiddleware(getOrCreateToken());

const assets = sirv(clientDir, {
  maxAge: 31536000,
  immutable: true,
  gzip: true,
  etag: true,
});

async function main() {
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

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`Web server listening on http://0.0.0.0:${port}`);

    // Branch status poller is started lazily by the watcher
    // when the first SSE subscriber connects.

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
    await stopTunnel().catch(() => {});
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
