/**
 * Minimal tRPC-only server for CLI integration tests.
 * No SSR, no static assets, no auth — just the tRPC router.
 *
 * Usage: BAND_HOME=/tmp/test PORT=0 node dist/test-server.mjs
 * Prints the actual port to stdout once listening.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createContext } from "./src/trpc/context.ts";
import { appRouter } from "./src/trpc/router.ts";

const port = parseInt(process.env.PORT || "0", 10);

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  if (!url.pathname.startsWith("/trpc")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

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

  const response = await fetchRequestHandler({
    endpoint: "/trpc",
    req: request,
    router: appRouter,
    createContext,
  });

  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  const text = await response.text();
  res.end(text);
});

server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  if (addr && typeof addr === "object") {
    // Print the port so the test harness can read it
    console.log(addr.port);
  }
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
