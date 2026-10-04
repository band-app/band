// Integration tests for worker tokens (plan step 2.4): a bootstrap token
// exchanges once for a session token bound to its worker id, over a real
// `LinkServer` and `LinkClient` on loopback, with `TokenService.authenticate`
// as the hub's authenticate callback. Real SQLite under a temp BAND_HOME.

import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LinkClient, LinkServer } from "@band-app/link";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import {
  hashToken,
  TokenExchangeError,
  TokenService,
  tokenService,
} from "../src/server/services/token-service";
import { assertTempBandHome } from "./helpers/band-home";
import { createTmpHome } from "./helpers/server";

let home: string;
let originalBandHome: string | undefined;
let dbPath: string;

const HELLO_INFO = {
  buildId: "test-build",
  mode: "attached" as const,
  capabilities: [],
  labels: {},
  roots: [],
  agents: [],
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

beforeAll(() => {
  originalBandHome = process.env.BAND_HOME;
  home = realpathSync(createTmpHome("band-worker-tokens-"));
  process.env.BAND_HOME = join(home, ".band");
  assertTempBandHome();
  mkdirSync(process.env.BAND_HOME, { recursive: true });
  dbPath = join(process.env.BAND_HOME, "band.db");
});

afterAll(() => {
  assertTempBandHome();
  closeDb();
  if (originalBandHome === undefined) delete process.env.BAND_HOME;
  else process.env.BAND_HOME = originalBandHome;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function hub(service: TokenService = tokenService) {
  const server = new LinkServer({ authenticate: service.authenticate });
  const port = await server.listen(0);
  cleanups.push(() => server.close());
  return { server, url: `ws://127.0.0.1:${port}/` };
}

function worker(
  url: string,
  workerId: string,
  token: string,
  extra: { useSessionToken?: boolean } = {},
) {
  const client = new LinkClient({
    url,
    token,
    hello: { ...HELLO_INFO, workerId },
    reconnect: false,
    ...extra,
  });
  cleanups.push(() => client.close());
  return client;
}

function ready(client: LinkClient): Promise<{ sessionToken: string }> {
  return new Promise((resolve) => client.once("connected", resolve));
}

function hostRow(id: string) {
  const sqlite = new DatabaseSync(dbPath);
  try {
    return sqlite.prepare("SELECT status, last_seen_at FROM hosts WHERE id = ?").get(id) as
      | { status: string; last_seen_at: number | null }
      | undefined;
  } finally {
    sqlite.close();
  }
}

describe("bootstrap exchange over the link", () => {
  it("S3: exchanges once for a session token bound to the worker id", async () => {
    const { token, hostId } = tokenService.issueWorkerBootstrap("box", ["gpu"], 60_000);
    expect(hostRow(hostId)).toMatchObject({ status: "offline", last_seen_at: null });
    const { url } = await hub();

    const first = worker(url, hostId, token);
    const connected = ready(first);
    await first.connect();
    const { sessionToken } = await connected;
    expect(sessionToken.startsWith("bws_")).toBe(true);
    expect(hostRow(hostId)).toMatchObject({ status: "online" });
    expect(hostRow(hostId)?.last_seen_at).toBeGreaterThan(0);

    // The bootstrap token is spent, whoever presents it.
    const again = worker(url, hostId, token);
    await expect(again.connect()).rejects.toThrow(/rejected/);
  });

  it("rejects a second exchange of the same bootstrap token", async () => {
    const { token, hostId } = tokenService.issueWorkerBootstrap("box2");
    expect(tokenService.exchangeBootstrap(token, hostId).startsWith("bws_")).toBe(true);
    expect(() => tokenService.exchangeBootstrap(token, hostId)).toThrowError(TokenExchangeError);
    try {
      tokenService.exchangeBootstrap(token, hostId);
    } catch (err) {
      expect((err as TokenExchangeError).reason).toBe("used");
    }
  });

  it("only one of two concurrent exchanges wins", async () => {
    const { token, hostId } = tokenService.issueWorkerBootstrap("racy");
    const { url } = await hub();
    const outcomes = await Promise.allSettled([
      worker(url, hostId, token).connect(),
      worker(url, hostId, token).connect(),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
  });

  it("rejects a mismatched worker id and leaves the token usable", async () => {
    const a = tokenService.issueWorkerBootstrap("a");
    const b = tokenService.issueWorkerBootstrap("b");
    const { url } = await hub();

    await expect(worker(url, b.hostId, a.token).connect()).rejects.toThrow(/rejected/);
    expect(() => tokenService.exchangeBootstrap(a.token, b.hostId)).toThrowError(/worker-mismatch/);

    const right = worker(url, a.hostId, a.token);
    await right.connect();
    expect(hostRow(a.hostId)?.status).toBe("online");
  });

  it("rejects an expired bootstrap token", async () => {
    let now = 1_000_000;
    const clocked = new TokenService(undefined, () => now);
    const { token, hostId } = clocked.issueWorkerBootstrap("late", [], 5_000);
    now += 5_001;
    const { url } = await hub(clocked);
    await expect(worker(url, hostId, token).connect()).rejects.toThrow(/rejected/);
    expect(() => clocked.exchangeBootstrap(token, hostId)).toThrowError(/expired/);
    now = 1_000_000 + 1_000;
    expect(clocked.exchangeBootstrap(token, hostId).startsWith("bws_")).toBe(true);
  });

  it("rejects unknown tokens and device tokens as worker credentials", async () => {
    const { hostId } = tokenService.issueWorkerBootstrap("c");
    const device = tokenService.createDevice("laptop");
    const { url } = await hub();
    await expect(worker(url, hostId, "nonsense").connect()).rejects.toThrow(/rejected/);
    await expect(worker(url, hostId, device.token).connect()).rejects.toThrow(/rejected/);
  });
});

describe("worker session tokens", () => {
  it("reconnects with the session token, and not as another worker", async () => {
    const a = tokenService.issueWorkerBootstrap("sa");
    const b = tokenService.issueWorkerBootstrap("sb");
    const sessionA = tokenService.exchangeBootstrap(a.token, a.hostId);
    const { url } = await hub();

    const reconnect = worker(url, a.hostId, sessionA);
    await reconnect.connect();

    await expect(worker(url, b.hostId, sessionA).connect()).rejects.toThrow(/rejected/);
  });

  it("stops authenticating once revoked", async () => {
    const { token, hostId } = tokenService.issueWorkerBootstrap("rv");
    const session = tokenService.exchangeBootstrap(token, hostId);
    const row = tokenService.list().find((t) => t.kind === "worker_session" && t.hostId === hostId);
    expect(row?.state).toBe("active");
    tokenService.revoke(row?.id ?? "");
    const { url } = await hub();
    await expect(worker(url, hostId, session).connect()).rejects.toThrow(/rejected/);
  });

  it("keeps only a hash of each token", () => {
    const { token, hostId } = tokenService.issueWorkerBootstrap("hash");
    const session = tokenService.exchangeBootstrap(token, hostId);
    const sqlite = new DatabaseSync(dbPath);
    const hashes = (sqlite.prepare("SELECT hash FROM tokens").all() as Array<{ hash: string }>).map(
      (r) => r.hash,
    );
    sqlite.close();
    expect(hashes).toContain(hashToken(token));
    expect(hashes).toContain(hashToken(session));
    expect(hashes).not.toContain(token);
    expect(hashes).not.toContain(session);
  });
});
