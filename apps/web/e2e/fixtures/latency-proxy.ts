/**
 * A TCP-level stand-in for a slow, jittery link to the hub. It forwards every
 * request to `target`, delays each one by `latencyMs`, and releases the
 * response of an event stream (`/events`) in `chunkBytes` slices, `chunkDelayMs`
 * apart, so a reader sees the replay arrive in several batches the way it does
 * over a congested connection. Nothing here reads or changes a payload.
 */

import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import net from "node:net";

export interface LatencyProxyOptions {
  target: string;
  latencyMs?: number;
  chunkBytes?: number;
  chunkDelayMs?: number;
}

export interface LatencyProxy {
  url: string;
  /** Paths (with query) of every request that reached the proxy. */
  requests: string[];
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startLatencyProxy(opts: LatencyProxyOptions): Promise<LatencyProxy> {
  const { latencyMs = 250, chunkBytes = 3000, chunkDelayMs = 120 } = opts;
  const target = new URL(opts.target);
  const requests: string[] = [];
  // The hub refuses an Origin that is not its own, so present the proxy's
  // requests as same-origin ones, as a page served by the hub itself would.
  const asTarget = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
    const out: http.OutgoingHttpHeaders = { ...headers, host: target.host };
    const rewrite = (v: string) => v.replace(/^https?:\/\/[^/]+/, target.origin);
    if (typeof out.origin === "string") out.origin = rewrite(out.origin);
    if (typeof out.referer === "string") out.referer = rewrite(out.referer);
    return out;
  };
  const sockets = new Set<Socket>();

  const server = http.createServer(async (req, res) => {
    requests.push(req.url ?? "");
    await sleep(latencyMs);
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: asTarget(req.headers),
      },
      async (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        const isStream = (up.headers["content-type"] ?? "").includes("text/event-stream");
        if (!isStream) {
          up.pipe(res);
          return;
        }
        try {
          for await (const chunk of up) {
            const buf = chunk as Buffer;
            for (let i = 0; i < buf.length; i += chunkBytes) {
              if (res.destroyed) return;
              res.write(buf.subarray(i, i + chunkBytes));
              await sleep(chunkDelayMs);
            }
          }
        } catch {
          // The page went away mid-stream; the close handler below tears down.
          res.destroy();
          return;
        }
        res.end();
      },
    );
    upstream.on("error", () => res.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });

  // WebSocket upgrades (tRPC subscriptions, terminals) pass through untouched.
  server.on("upgrade", (req, clientSocket, head) => {
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const lower = name.toLowerCase();
        const value = req.rawHeaders[i + 1];
        lines.push(
          `${name}: ${lower === "host" ? target.host : lower === "origin" ? target.origin : value}`,
        );
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      clientSocket.pipe(upstream).pipe(clientSocket);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
