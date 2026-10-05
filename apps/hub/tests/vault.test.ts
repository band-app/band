// Integration tests for the credential vault and OAuth consent flow (plan step 4.1). Real production
// server on a random port against a temp BAND_HOME. The authorization server is a real local Express
// stub (`fixtures/oauth-stub.ts`) with discovery, dynamic client registration and PKCE.

import { createDecipheriv } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OAuthStub, startOAuthStub } from "./fixtures/oauth-stub";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const ADMIN = "vault-admin-shared-secret";
const API_KEY = "sk-live-VAULT-PLAINTEXT-0123456789";

let home: string;
let server: ServerHandle;
let oauth: OAuthStub;
let logFile: string;

interface Item {
  id: string;
  name: string;
  kind: string;
  scope: string;
  metadata: Record<string, unknown>;
  lastUsedAt: number | null;
}

const m = async <T>(proc: string, input: unknown, token = ADMIN) => {
  const res = await trpcMutate(server.url, proc, input, token);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const q = async <T>(proc: string, input?: unknown) => {
  const res = await trpcQuery(server.url, proc, input, ADMIN);
  expect(res.status).toBe(200);
  return trpcData<T>(res);
};
const list = () => q<{ items: Item[]; keySource: string }>("vault.list");

/** Every byte under the temp home that the hub wrote: the DB files, key file and server log. */
function allBytes(): Buffer {
  const chunks: Buffer[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.size < 64 * 1024 * 1024) {
        try {
          chunks.push(readFileSync(full));
        } catch {
          // a socket or a file that vanished
        }
      }
    }
  };
  walk(join(home, ".band"));
  chunks.push(readFileSync(logFile));
  return Buffer.concat(chunks);
}

/** Drives the consent: opens the authorization URL (the stub consents at once) and follows its redirect to the hub. */
async function consent(authorizationUrl: string): Promise<Response> {
  const auth = await fetch(authorizationUrl, { redirect: "manual" });
  expect(auth.status).toBe(302);
  return fetch(auth.headers.get("location") as string);
}

beforeAll(async () => {
  home = createTmpHome("band-vault-");
  logFile = join(home, "server.log");
  process.env.BAND_TEST_SERVER_LOG = logFile;
  seedSettings(home, { tokenSecret: ADMIN });
  oauth = await startOAuthStub({ expiresIn: 3600 });
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_SERVE_UI: "false",
      BAND_VAULT_REFRESH_POLL_MS: "500",
      BAND_VAULT_REFRESH_SKEW_MS: "2000",
    },
  });
}, 60_000);

afterAll(async () => {
  await server?.close();
  await oauth?.close();
  delete process.env.BAND_TEST_SERVER_LOG;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("encryption at rest (S1)", () => {
  it("keeps a stored API key out of the DB, the log and every API response", async () => {
    const put = await trpcMutate(
      server.url,
      "vault.put",
      { name: "OPENAI_API_KEY", kind: "api_key", value: API_KEY, scope: "global" },
      ADMIN,
    );
    expect(put.status).toBe(200);
    const putBody = await put.text();
    expect(putBody).not.toContain(API_KEY);

    const listed = await trpcQuery(server.url, "vault.list", undefined, ADMIN);
    const listedBody = await listed.text();
    expect(listedBody).toContain("OPENAI_API_KEY");
    expect(listedBody).not.toContain(API_KEY);
    expect(listedBody).not.toContain("encrypted");

    const bytes = allBytes();
    // The scan reads the DB: the item's name is stored in the clear, its value is not.
    expect(bytes.includes(Buffer.from("OPENAI_API_KEY"))).toBe(true);
    expect(bytes.includes(Buffer.from(API_KEY))).toBe(false);
    expect(bytes.includes(Buffer.from(API_KEY).toString("base64"))).toBe(false);

    const item = (await list()).items.find((i) => i.name === "OPENAI_API_KEY");
    expect(item).toMatchObject({ kind: "api_key", scope: "global", lastUsedAt: null });
  });

  it("writes the key file with mode 0600", () => {
    const mode = statSync(join(home, ".band", "vault.key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("replaces a value under the same name and scope, and keeps scopes apart", async () => {
    await m("vault.put", { name: "OPENAI_API_KEY", value: "second-value", scope: "global" });
    await m("vault.put", { name: "OPENAI_API_KEY", value: "scoped", scope: "repo:demo" });
    const items = (await list()).items.filter((i) => i.name === "OPENAI_API_KEY");
    expect(items.map((i) => i.scope).sort()).toEqual(["global", "repo:demo"]);
  });

  it("refuses bad names, scopes and env names", async () => {
    for (const bad of [
      { name: "../x", value: "v", scope: "global" },
      { name: "ok", value: "v", scope: "somewhere" },
      { name: "has space", kind: "env", value: "v", scope: "global" },
    ]) {
      const res = await trpcMutate(server.url, "vault.put", bad, ADMIN);
      expect(res.status).toBe(400);
    }
  });
});

describe("key rotation (S2)", () => {
  it("re-encrypts every item, and the old key no longer decrypts", async () => {
    const dbBlobs = async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(home, ".band", "band.db"));
      try {
        return db.prepare("SELECT id, encrypted FROM vault_items ORDER BY id").all() as Array<{
          id: string;
          encrypted: string;
        }>;
      } finally {
        db.close();
      }
    };
    const open = (key: Buffer, row: { id: string; encrypted: string }) => {
      const raw = Buffer.from(row.encrypted.slice(3), "base64");
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(row.id));
      d.setAuthTag(raw.subarray(raw.length - 16));
      return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString();
    };
    const keyFile = join(home, ".band", "vault.key");
    const oldKey = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
    const before = await dbBlobs();
    expect(before.length).toBeGreaterThan(0);
    for (const row of before) expect(() => open(oldKey, row)).not.toThrow();

    const { rotated } = await m<{ rotated: number }>("vault.rotateKey", {});
    expect(rotated).toBe(before.length);

    const newKey = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
    expect(newKey.equals(oldKey)).toBe(false);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const after = await dbBlobs();
    for (const row of after) {
      expect(() => open(oldKey, row)).toThrow();
      expect(open(newKey, row).length).toBeGreaterThan(0);
    }
    expect(after.map((r) => r.encrypted)).not.toEqual(before.map((r) => r.encrypted));
    // The running hub switched to the new key too.
    await m("vault.put", { name: "AFTER_ROTATION", value: "v", scope: "global" });
  });
});

describe("OAuth (S3)", () => {
  let itemId: string;

  it("discovers, registers a client, consents with PKCE, and stores the tokens encrypted", async () => {
    const started = await m<{ flowId: string; authorizationUrl: string }>("vault.startOAuth", {
      name: "demo-mcp",
      serverUrl: oauth.resourceUrl,
      scope: "global",
      redirectBase: server.url,
    });
    expect(oauth.registrations).toHaveLength(1);
    expect(oauth.registrations[0]).toMatchObject({
      redirect_uris: [`${server.url}/api/oauth/callback`],
      token_endpoint_auth_method: "none",
    });
    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(oauth.resourceUrl);
    expect(
      (await q<{ status: string }>("vault.oauthStatus", { flowId: started.flowId })).status,
    ).toBe("pending");

    const page = await consent(started.authorizationUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Connected");

    const status = await q<{ status: string; item: Item }>("vault.oauthStatus", {
      flowId: started.flowId,
    });
    expect(status.status).toBe("connected");
    itemId = status.item.id;
    expect(status.item).toMatchObject({ name: "demo-mcp", kind: "oauth" });
    expect(status.item.metadata).toMatchObject({
      account: "tester@example.test",
      scopes: "read write",
      issuer: oauth.origin,
    });

    const [token] = oauth.liveAccessTokens();
    const bytes = allBytes();
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    const listedBody = await (await trpcQuery(server.url, "vault.list", undefined, ADMIN)).text();
    expect(listedBody).not.toContain(token);
    expect(listedBody).not.toContain("rt-");
  });

  it("refuses a replayed, forged or missing state", async () => {
    const started = await m<{ flowId: string; authorizationUrl: string }>("vault.startOAuth", {
      name: "demo-state",
      serverUrl: oauth.resourceUrl,
      scope: "global",
      redirectBase: server.url,
    });
    const auth = await fetch(started.authorizationUrl, { redirect: "manual" });
    const back = auth.headers.get("location") as string;

    const forged = new URL(back);
    forged.searchParams.set("state", "forged");
    expect((await fetch(forged)).status).toBe(400);
    const noState = new URL(back);
    noState.searchParams.delete("state");
    expect((await fetch(noState)).status).toBe(400);

    expect((await fetch(back)).status).toBe(200);
    // Single use: the same redirect again matches nothing.
    expect((await fetch(back)).status).toBe(400);
    await m("vault.delete", {
      id: (await q<{ item: Item }>("vault.oauthStatus", { flowId: started.flowId })).item.id,
    });
  });

  it("refuses an authorization server redirect that names another issuer", async () => {
    const started = await m<{ authorizationUrl: string }>("vault.startOAuth", {
      name: "demo-iss",
      serverUrl: oauth.resourceUrl,
      scope: "global",
      redirectBase: server.url,
    });
    const auth = await fetch(started.authorizationUrl, { redirect: "manual" });
    const back = new URL(auth.headers.get("location") as string);
    back.searchParams.set("iss", "http://evil.example");
    expect((await fetch(back)).status).toBe(400);
    expect((await list()).items.some((i) => i.name === "demo-iss")).toBe(false);
  });

  it("refreshes before the token expires", async () => {
    oauth.setExpiresIn(2);
    const started = await m<{ flowId: string; authorizationUrl: string }>("vault.startOAuth", {
      name: "short-lived",
      serverUrl: oauth.resourceUrl,
      scope: "global",
      redirectBase: server.url,
    });
    await consent(started.authorizationUrl);
    const first = oauth.tokenRequests.filter((r) => r.grant_type === "authorization_code").length;
    expect(first).toBeGreaterThan(0);
    // 2 s lifetime inside a 2 s skew: the sweep (every 500 ms) refreshes at once.
    await waitFor(() => oauth.tokenRequests.some((r) => r.grant_type === "refresh_token"), {
      timeoutMs: 10_000,
      label: "a refresh_token grant",
    });
    const refresh = oauth.tokenRequests.find((r) => r.grant_type === "refresh_token");
    expect(refresh?.resource).toBe(oauth.resourceUrl);
    const item = (await list()).items.find((i) => i.name === "short-lived");
    expect(item?.metadata.refreshedAt).toBeTypeOf("number");
    expect(item?.metadata.refreshError).toBeUndefined();
    expect(allBytes().includes(Buffer.from(oauth.liveAccessTokens().at(-1) as string))).toBe(false);
    oauth.setExpiresIn(3600);
    await m("vault.delete", { id: (item as Item).id });
  });

  it("revokes at the server when the connection is deleted", async () => {
    const revoked = oauth.revocations.length;
    const result = await m<{ removed: boolean; revoked: boolean }>("vault.delete", { id: itemId });
    expect(result).toEqual({ removed: true, revoked: true });
    expect(oauth.revocations).toHaveLength(revoked + 1);
    expect(oauth.revocations.at(-1)?.token).toMatch(/^rt-/);
    expect((await list()).items.some((i) => i.id === itemId)).toBe(false);
  });

  it("needs a client id when the server has no dynamic registration", async () => {
    const bare = await startOAuthStub({ dcr: false });
    try {
      const refused = await trpcMutate(
        server.url,
        "vault.startOAuth",
        { name: "bare", serverUrl: bare.resourceUrl, scope: "global", redirectBase: server.url },
        ADMIN,
      );
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain("client id");
    } finally {
      await bare.close();
    }
  });
});

describe("access control (S4)", () => {
  it("answers 403 to a non-admin device token on every vault procedure", async () => {
    const { token } = await m<{ token: string }>("tokens.createDevice", {
      label: "plain",
      admin: false,
    });
    const registrationsBefore = oauth.registrations.length;
    const calls: Array<[string, "q" | "m", unknown]> = [
      ["vault.list", "q", undefined],
      ["vault.put", "m", { name: "x", value: "y", scope: "global" }],
      ["vault.delete", "m", { id: "nope" }],
      ["vault.rotateKey", "m", {}],
      ["vault.startOAuth", "m", { name: "x", serverUrl: oauth.resourceUrl, scope: "global" }],
      ["vault.oauthStatus", "q", { flowId: "x" }],
    ];
    for (const [proc, kind, input] of calls) {
      const res =
        kind === "q"
          ? await trpcQuery(server.url, proc, input, token)
          : await trpcMutate(server.url, proc, input, token);
      expect(res.status, proc).toBe(403);
    }
    // Nothing was started by those refused calls.
    expect(oauth.registrations).toHaveLength(registrationsBefore);
  });
});

describe("no token", () => {
  it("answers 401 to a vault call with no credentials", async () => {
    const list = await fetch(`${server.url}/trpc/vault.list`);
    expect(list.status).toBe(401);
    const put = await fetch(`${server.url}/trpc/vault.put`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", value: "y", scope: "global" }),
    });
    expect(put.status).toBe(401);
  });
});

describe("a key from BAND_VAULT_KEY", () => {
  it("encrypts with it, writes no key file, and refuses to rotate it", async () => {
    const envHome = createTmpHome("band-vault-env-");
    seedSettings(envHome, { tokenSecret: ADMIN });
    const key = Buffer.alloc(32, 7).toString("base64");
    const envServer = await startServer({
      remoteHost: false,
      tmpHome: envHome,
      env: { BAND_SERVE_UI: "false", BAND_VAULT_KEY: key },
    });
    try {
      const put = await trpcMutate(
        envServer.url,
        "vault.put",
        { name: "K", value: "env-key-value", scope: "global" },
        ADMIN,
      );
      expect(put.status).toBe(200);
      const listed = await trpcData<{ keySource: string }>(
        await trpcQuery(envServer.url, "vault.list", undefined, ADMIN),
      );
      expect(listed.keySource).toBe("env");
      expect(() => readFileSync(join(envHome, ".band", "vault.key"))).toThrow();
      const rotate = await trpcMutate(envServer.url, "vault.rotateKey", {}, ADMIN);
      expect(rotate.status).toBe(400);
    } finally {
      await envServer.close();
      rmSync(envHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
