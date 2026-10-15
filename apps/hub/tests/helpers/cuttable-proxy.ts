// A TCP proxy in front of the hub that a test can cut and restore, so a worker that dials it loses
// its link the way it does when the network goes away: open sockets die and new dials are refused.

import { createServer, type Server, Socket } from "node:net";

export interface CuttableProxy {
  /** `http://127.0.0.1:<port>`, to give the worker as its hub URL. */
  url: string;
  /** Drops every open connection and refuses new ones. */
  cut(): Promise<void>;
  /** Accepts connections again on the same port. */
  restore(): Promise<void>;
  close(): Promise<void>;
}

export async function startCuttableProxy(target: string): Promise<CuttableProxy> {
  const { hostname, port: targetPort } = new URL(target);
  const sockets = new Set<Socket>();
  let server: Server | null = null;
  let port = 0;

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      const next = createServer((client) => {
        const upstream = new Socket();
        sockets.add(client);
        sockets.add(upstream);
        const drop = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on("error", drop).on("close", drop);
        upstream.on("error", drop).on("close", drop);
        upstream.connect(Number(targetPort), hostname, () => {
          client.pipe(upstream);
          upstream.pipe(client);
        });
      });
      next.once("error", reject);
      next.listen(port, "127.0.0.1", () => {
        port = (next.address() as { port: number }).port;
        server = next;
        resolve();
      });
    });

  const stop = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      const current = server;
      server = null;
      if (!current) return resolve();
      current.close(() => resolve());
    });

  await listen();
  return {
    url: `http://127.0.0.1:${port}`,
    cut: stop,
    restore: listen,
    close: stop,
  };
}
