import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import sirv from "sirv";
import { createAuthMiddleware } from "./auth.ts";
import { startBranchStatusPoller, stopBranchStatusPoller } from "./src/lib/branch-status-poller.ts";
import { checkPrereqs } from "./src/lib/process-utils.ts";
import { loadSettings } from "./src/lib/state.ts";
import { startTunnel, stopTunnel } from "./src/lib/tunnel.ts";

// After bundling, this file lives at dist/start-server.mjs,
// so paths are relative to dist/.
const clientDir = join(import.meta.dirname, "client");
const port = parseInt(process.env.PORT || "3456", 10);

const { handleAuth } = createAuthMiddleware(process.env.BAND_TOKEN_SECRET);

const assets = sirv(clientDir, {
  maxAge: 31536000,
  immutable: true,
  gzip: true,
  etag: true,
});

async function main() {
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

    // Start branch status poller
    startBranchStatusPoller();

    // Auto-start tunnel if configured
    const settings = loadSettings() as Record<string, unknown>;
    if (settings.autoStartTunnel) {
      checkPrereqs()
        .then((prereqs) => {
          if (prereqs.instatunnel) {
            return startTunnel({
              port,
              subdomain: settings.tunnelSubdomain as string | undefined,
            });
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
