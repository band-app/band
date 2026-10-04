import type { EventEmitter } from "node:events";
import {
  LinkClient,
  type LinkClientOptions,
  LinkServer,
  type LinkServerOptions,
  type ServerSession,
} from "../src/index.ts";

export const TOKEN = "secret";

export const HELLO = {
  workerId: "w1",
  buildId: "build-1",
  mode: "attached" as const,
  capabilities: ["pty"],
  labels: { os: "linux" },
  roots: ["/work"],
  agents: ["claude-code"],
};

export async function startServer(opts: Partial<LinkServerOptions> = {}) {
  const server = new LinkServer({
    authenticate: (hello) =>
      hello.token === TOKEN ? { ok: true } : { ok: false, reason: "bad token" },
    ...opts,
  });
  const port = await server.listen(0);
  return { server, url: `ws://127.0.0.1:${port}/` };
}

export function makeClient(url: string, opts: Partial<LinkClientOptions> = {}) {
  return new LinkClient({
    url,
    token: TOKEN,
    hello: HELLO,
    reconnect: { minMs: 20, maxMs: 100 },
    ...opts,
  });
}

/** Resolves with the server's session for a worker once it connects. */
export function nextSession(server: LinkServer, workerId = HELLO.workerId): Promise<ServerSession> {
  const existing = server.getSession(workerId);
  if (existing?.attached) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const onConnected = (s: ServerSession) => {
      if (s.workerId !== workerId) return;
      server.off("connected", onConnected);
      resolve(s);
    };
    server.on("connected", onConnected);
  });
}

export function once<T = unknown>(emitter: EventEmitter, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, (v: T) => resolve(v)));
}

export async function waitFor(
  cond: () => boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
