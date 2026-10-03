import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";

const CLIENT_DIR = join(import.meta.dirname, "../../dist/client");

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

export interface StaticUiServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Serves the built UI (`apps/web/dist/client`) the way a plain static host
 * would: files by path, `_shell.html` for any path that isn't a file. It has no
 * API and knows nothing about the hub, so the page it serves must reach the hub
 * on another origin.
 */
export function startStaticUiServer(port: number): Promise<StaticUiServer> {
  const server: Server = createServer((req, res) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }
    const candidate = normalize(join(CLIENT_DIR, pathname));
    const isFile =
      candidate.startsWith(CLIENT_DIR) && existsSync(candidate) && statSync(candidate).isFile();
    const file = isFile ? candidate : join(CLIENT_DIR, "_shell.html");
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
