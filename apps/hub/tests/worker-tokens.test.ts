// Integration tests for worker bootstrap tokens (plan step 2.4), through the
// real server's `tokens.*` and `hosts.list` API. Exchanging a bootstrap token
// for a session token happens on the worker link, which has no endpoint until
// step 2.3, so that half is tested there through `/api/workers/connect`.

import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "worker-tokens-shared-secret";

let home: string;
let server: ServerHandle;

interface TokenView {
  id: string;
  kind: string;
  label: string;
  hostId: string | null;
  state: string;
  expiresAt: number | null;
}

interface Issued {
  token: string;
  hostId: string;
  view: TokenView;
}

interface HostView {
  id: string;
  name: string;
  status: string;
  labels: string[];
}

beforeAll(async () => {
  home = createTmpHome("band-worker-tokens-");
  seedSettings(home, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome: home });
}, 60_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function issue(input: Record<string, unknown>): Promise<Response> {
  return trpcMutate(server.url, "tokens.issueWorkerBootstrap", input, TOKEN);
}

async function listTokens(): Promise<TokenView[]> {
  const res = await trpcQuery(server.url, "tokens.list", undefined, TOKEN);
  return (await trpcData<{ tokens: TokenView[] }>(res)).tokens;
}

async function listHosts(): Promise<HostView[]> {
  const res = await trpcQuery(server.url, "hosts.list", undefined, TOKEN);
  return (await trpcData<{ hosts: HostView[] }>(res)).hosts;
}

describe("authentication", () => {
  it("refuses every token procedure without a valid token", async () => {
    for (const token of ["", "not-a-token"]) {
      expect((await trpcQuery(server.url, "tokens.list", undefined, token)).status).toBe(401);
      expect((await trpcQuery(server.url, "hosts.list", undefined, token)).status).toBe(401);
      const issued = await trpcMutate(
        server.url,
        "tokens.issueWorkerBootstrap",
        { hostName: "intruder" },
        token,
      );
      expect(issued.status).toBe(401);
    }
    expect((await listHosts()).some((h) => h.name === "intruder")).toBe(false);
  });
});

describe("issuing a worker bootstrap token", () => {
  it("registers an offline host bound to the token, with the requested labels", async () => {
    const res = await issue({ hostName: "gpu box", labels: ["os=linux", "gpu"] });
    expect(res.status).toBe(200);
    const issued = await trpcData<Issued>(res);

    expect(issued.token).toMatch(/^bwb_/);
    expect(issued.hostId).toMatch(/^h-[0-9a-f]{12}$/);
    expect(issued.view).toMatchObject({
      kind: "worker_bootstrap",
      label: "gpu box",
      hostId: issued.hostId,
      state: "active",
    });

    const host = (await listHosts()).find((h) => h.id === issued.hostId);
    expect(host).toMatchObject({
      name: "gpu box",
      status: "offline",
      labels: ["os=linux", "gpu"],
    });
    const listed = (await listTokens()).find((t) => t.id === issued.view.id);
    expect(listed).toMatchObject({ kind: "worker_bootstrap", state: "active" });
  });

  it("expires after one hour by default and honours a requested lifetime", async () => {
    const before = Date.now();
    const byDefault = await trpcData<Issued>(await issue({ hostName: "default ttl" }));
    const short = await trpcData<Issued>(await issue({ hostName: "short ttl", ttlMinutes: 5 }));

    const defaultTtl = (byDefault.view.expiresAt ?? 0) - before;
    expect(defaultTtl).toBeGreaterThan(59 * 60_000);
    expect(defaultTtl).toBeLessThanOrEqual(61 * 60_000);
    const shortTtl = (short.view.expiresAt ?? 0) - before;
    expect(shortTtl).toBeGreaterThan(4 * 60_000);
    expect(shortTtl).toBeLessThanOrEqual(6 * 60_000);
  });

  it("refuses a lifetime over seven days and an empty host name", async () => {
    expect((await issue({ hostName: "forever", ttlMinutes: 7 * 24 * 60 + 1 })).status).toBe(400);
    expect((await issue({ hostName: "  " })).status).toBe(400);
  });

  it("gives every host its own id", async () => {
    const a = await trpcData<Issued>(await issue({ hostName: "same name" }));
    const b = await trpcData<Issued>(await issue({ hostName: "same name" }));
    expect(a.hostId).not.toBe(b.hostId);
    expect(a.token).not.toBe(b.token);
  });
});

describe("revoking a worker bootstrap token", () => {
  it("marks it revoked, keeps the host listed, and is idempotent", async () => {
    const issued = await trpcData<Issued>(await issue({ hostName: "revoked box" }));

    for (let i = 0; i < 2; i++) {
      const res = await trpcMutate(server.url, "tokens.revoke", { tokenId: issued.view.id }, TOKEN);
      expect(res.status).toBe(200);
    }
    const row = (await listTokens()).find((t) => t.id === issued.view.id);
    expect(row?.state).toBe("revoked");
    expect((await listHosts()).map((h) => h.id)).toContain(issued.hostId);
  });
});
