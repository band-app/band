// Integration tests for revocable tokens (plan step 2.4): the shared token
// survives an upgrade as a device token, revoked device tokens lose HTTP and
// WebSocket access, tokens are stored hashed and never written to disk in the
// clear. Real production server on a random port with auth on.

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const SHARED_TOKEN = "tokens-auth-shared-secret";
const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const TOKENS_MIGRATION = "20261004022553_tokens";

let home: string;
let server: ServerHandle;

interface TokenView {
  id: string;
  kind: string;
  label: string;
  hostId: string | null;
  state: string;
  lastUsedAt: number | null;
}

beforeAll(async () => {
  home = createTmpHome("band-tokens-auth-");
  seedSettings(home, { tokenSecret: SHARED_TOKEN });

  // An install from before this step: every migration except the tokens one,
  // plus a project row, so the upgrade keeps data.
  const before = join(home, "migrations-before");
  cpSync(migrationsDir, before, { recursive: true });
  expect(readdirSync(before)).toContain(TOKENS_MIGRATION);
  rmSync(join(before, TOKENS_MIGRATION), { recursive: true });
  const sqlite = new DatabaseSync(join(home, ".band", "band.db"));
  migrate(drizzle({ client: sqlite }), { migrationsFolder: before });
  sqlite.exec(
    "INSERT INTO projects (name, path, default_branch, sort_order) VALUES ('old', '/repos/old', 'main', 0)",
  );
  sqlite.close();

  server = await startServer({ tmpHome: home });
}, 60_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function listTokens(token = SHARED_TOKEN): Promise<TokenView[]> {
  const res = await trpcQuery(server.url, "tokens.list", undefined, token);
  expect(res.status).toBe(200);
  return (await trpcData<{ tokens: TokenView[] }>(res)).tokens;
}

async function createDevice(label: string): Promise<{ token: string; view: TokenView }> {
  const res = await trpcMutate(server.url, "tokens.createDevice", { label }, SHARED_TOKEN);
  expect(res.status).toBe(200);
  return trpcData(res);
}

function wsOutcome(token: string, path = "/trpc"): Promise<"open" | "closed"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${server.url.replace("http", "ws")}${path}`, [
      "band",
      `band-token.${token}`,
    ]);
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("error", () => resolve("closed"));
    ws.on("unexpected-response", () => resolve("closed"));
  });
}

describe("upgrading with the shared token", () => {
  it("keeps the old shared token working over every transport", async () => {
    expect(
      (await fetch(`${server.url}/api/health`, { headers: bearer(SHARED_TOKEN) })).status,
    ).toBe(200);
    const cookie = await fetch(`${server.url}/trpc/projects.list`, {
      headers: { Cookie: `band_token=${SHARED_TOKEN}` },
    });
    expect(cookie.status).toBe(200);
    expect(await wsOutcome(SHARED_TOKEN)).toBe("open");
    expect((await fetch(`${server.url}/trpc/projects.list`)).status).toBe(401);
  });

  it("lists the shared token as a device token and keeps the old data", async () => {
    const shared = (await listTokens()).find((t) => t.id === "shared");
    expect(shared).toMatchObject({ kind: "device", state: "active" });
    const projects = await trpcQuery(server.url, "projects.list", undefined, SHARED_TOKEN);
    const { projects: listed } = await trpcData<{ projects: Array<{ name: string }> }>(projects);
    expect(listed.map((p) => p.name)).toContain("old");
  });

  it("refuses to revoke the shared token", async () => {
    const res = await trpcMutate(server.url, "tokens.revoke", { tokenId: "shared" }, SHARED_TOKEN);
    expect(res.status).toBe(409);
    expect(
      (await fetch(`${server.url}/api/health`, { headers: bearer(SHARED_TOKEN) })).status,
    ).toBe(200);
  });
});

describe("device tokens", () => {
  it("authenticates a new device token and records when it was last used", async () => {
    const { token, view } = await createDevice("phone");
    expect(token.startsWith("bdt_")).toBe(true);
    expect(view).toMatchObject({ kind: "device", label: "phone", state: "active" });
    expect(
      (await fetch(`${server.url}/trpc/projects.list`, { headers: bearer(token) })).status,
    ).toBe(200);
    const row = (await listTokens(token)).find((t) => t.id === view.id);
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("S2: a revoked device token gets 401 on HTTP and a closed socket on WS", async () => {
    const { token, view } = await createDevice("laptop");
    expect(await wsOutcome(token)).toBe("open");

    // A socket opened before the revoke closes when it happens.
    const live = new WebSocket(`${server.url.replace("http", "ws")}/trpc`, [
      "band",
      `band-token.${token}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      live.on("open", () => resolve());
      live.on("error", reject);
    });
    const closed = new Promise<void>((resolve, reject) => {
      live.on("close", () => resolve());
      setTimeout(
        () => reject(new Error("socket was not closed within 5 s of the revoke")),
        5_000,
      ).unref();
    });

    const res = await trpcMutate(server.url, "tokens.revoke", { tokenId: view.id }, SHARED_TOKEN);
    expect(res.status).toBe(200);
    await closed;

    for (const request of [
      fetch(`${server.url}/trpc/projects.list`, { headers: bearer(token) }),
      fetch(`${server.url}/api/health`, { headers: bearer(token) }),
      fetch(`${server.url}/trpc/projects.list`, { headers: { Cookie: `band_token=${token}` } }),
      fetch(`${server.url}/api/uploads/x.png?token=${token}`),
    ]) {
      expect((await request).status).toBe(401);
    }
    expect(await wsOutcome(token)).toBe("closed");
    expect(await wsOutcome(token, "/terminal?workspaceId=none&terminalId=none")).toBe("closed");

    const state = (await listTokens()).find((t) => t.id === view.id)?.state;
    expect(state).toBe("revoked");
  });

  it("answers an unknown token id with 404", async () => {
    const res = await trpcMutate(server.url, "tokens.revoke", { tokenId: "nope" }, SHARED_TOKEN);
    expect(res.status).toBe(404);
  });

  it("a worker bootstrap token does not authenticate the UI API", async () => {
    const res = await trpcMutate(
      server.url,
      "tokens.issueWorkerBootstrap",
      { hostName: "build box", labels: ["os=linux"] },
      SHARED_TOKEN,
    );
    expect(res.status).toBe(200);
    const issued = await trpcData<{ token: string; hostId: string; view: TokenView }>(res);
    expect(issued.token.startsWith("bwb_")).toBe(true);
    expect(issued.view).toMatchObject({
      kind: "worker_bootstrap",
      hostId: issued.hostId,
      state: "active",
    });
    expect(
      (await fetch(`${server.url}/trpc/projects.list`, { headers: bearer(issued.token) })).status,
    ).toBe(401);
    expect(await wsOutcome(issued.token)).toBe("closed");

    const hosts = await trpcData<{
      hosts: Array<{ id: string; name: string; status: string; labels: string[] }>;
    }>(await trpcQuery(server.url, "hosts.list", undefined, SHARED_TOKEN));
    expect(hosts.hosts.map((h) => h.id)).toEqual(["local", issued.hostId]);
    expect(hosts.hosts[1]).toMatchObject({
      name: "build box",
      status: "offline",
      labels: ["os=linux"],
    });
  });
});

describe("secrets at rest", () => {
  it("S5: stores only hashes and writes no issued token to the home directory", async () => {
    const device = await createDevice("audit");
    const bootstrap = await trpcData<{ token: string }>(
      await trpcMutate(
        server.url,
        "tokens.issueWorkerBootstrap",
        { hostName: "audit host" },
        SHARED_TOKEN,
      ),
    );
    await trpcMutate(server.url, "tokens.revoke", { tokenId: device.view.id }, SHARED_TOKEN);

    const sqlite = new DatabaseSync(join(home, ".band", "band.db"));
    const rows = sqlite.prepare("SELECT id, hash FROM tokens").all() as Array<{
      id: string;
      hash: string;
    }>;
    sqlite.close();
    const hashOf = (t: string) => createHash("sha256").update(t).digest("hex");
    expect(rows.find((r) => r.id === device.view.id)?.hash).toBe(hashOf(device.token));
    expect(rows.find((r) => r.id === "shared")?.hash).toBe(hashOf(SHARED_TOKEN));
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash))).toBe(true);

    // settings.json legitimately holds the shared token. Nothing else may hold a secret.
    const secrets = [device.token, bootstrap.token];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path);
        else if (stat.size < 50_000_000) {
          const text = readFileSync(path).toString("latin1");
          if (secrets.some((s) => text.includes(s))) hits.push(path);
        }
      }
    };
    mkdirSync(join(home, ".band"), { recursive: true });
    walk(join(home, ".band"));
    expect(hits).toEqual([]);
  });
});
