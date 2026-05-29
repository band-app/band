import type { Server as HttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";

/**
 * Ask the OS kernel for any free TCP port on 127.0.0.1.
 *
 * Used by the integration test suite so each spawned subprocess gets a
 * port that no other test (and ideally no other process on the host) is
 * using. The TCP-listen-then-close dance is the standard
 * "kernel-picks-a-free-port" trick — `port: 0` tells the kernel to
 * allocate one for us.
 *
 * Note the TOCTOU window: between this returning and the caller binding,
 * another process could theoretically claim the port. In practice the
 * window is microseconds and tests have not flaked on this; production
 * boot uses `listenWithFallback` below instead, which is robust to the
 * race by binding the real server directly and retrying on `EADDRINUSE`.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("invalid address"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Call `httpServer.listen(port, "0.0.0.0")` and retry on `EADDRINUSE`,
 * advancing the port number by one each time, until we successfully
 * bind or exhaust the attempt budget. Returns the port that actually
 * got claimed.
 *
 * Used by `start-server.ts` so the dev server doesn't crash when the
 * packaged Band desktop app already holds the default port — it just
 * announces the next free port and the dev-desktop orchestrator picks
 * the new port up from the existing "Web server listening on
 * http://0.0.0.0:<port>" log banner.
 *
 * Robust against the TOCTOU race that `findFreePort` has, because this
 * binds the real server directly. If the bind races a concurrent
 * claim, the `error` listener catches it and we just advance to the
 * next port.
 */
export async function listenWithFallback(
  server: HttpServer,
  startPort: number,
  attempts = 20,
): Promise<number> {
  for (let port = startPort; port < startPort + attempts; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        try {
          server.listen(port, "0.0.0.0");
        } catch (err) {
          // `server.listen()` throws synchronously in some failure
          // modes — most commonly `ERR_SERVER_ALREADY_LISTEN` if
          // a caller re-uses an already-bound server. Remove the
          // listeners we just registered so they don't accumulate
          // across retries (each leaked pair is two MaxListeners
          // warnings closer to a process-wide warning storm).
          server.removeListener("error", onError);
          server.removeListener("listening", onListening);
          reject(err);
        }
      });
      return port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      // Port busy — fall through and try the next one.
    }
  }
  throw new Error(
    `Failed to find a free port in range ${startPort}..${startPort + attempts - 1} ` +
      `(all ${attempts} ports were in use).`,
  );
}
