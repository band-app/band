// Integration tests for device pairing links: a one-time `bdp_` code bound to a device row,
// the public exchange route, revoke that deletes the device, the address picker procedures and
// the 403 for a non-admin device. Real production server on a random port with auth on.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const SHARED = "device-pairing-shared-secret";
const PUBLIC_URL = "https://band.example.ts.net";

let home: string;
let server: ServerHandle;

interface TokenView {
  id: string;
  kind: string;
  label: string;
  admin: boolean;
  state: string;
}
interface Pairing {
  deviceId: string;
  code: string;
  expiresAt: number;
}

beforeAll(async () => {
  home = createTmpHome("band-device-pairing-");
  seedSettings(home, { tokenSecret: SHARED });
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    // A short lifetime, as BAND_DIRECT_TOKEN_TTL_MS does for direct tokens.
    env: { BAND_PAIRING_TTL_MS: "2500", BAND_PUBLIC_URL: PUBLIC_URL },
  });
}, 60_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function listDevices(): Promise<TokenView[]> {
  const res = await trpcQuery(server.url, "tokens.list", undefined, SHARED);
  return (await trpcData<{ tokens: TokenView[] }>(res)).tokens.filter((t) => t.kind === "device");
}

async function createUnpaired(label: string, admin = false): Promise<TokenView> {
  const res = await trpcMutate(server.url, "tokens.createUnpairedDevice", { label, admin }, SHARED);
  expect(res.status).toBe(200);
  return (await trpcData<{ view: TokenView }>(res)).view;
}

async function pairing(tokenId: string, regenerate = false): Promise<Pairing> {
  const res = await trpcMutate(server.url, "tokens.pairing", { tokenId, regenerate }, SHARED);
  expect(res.status).toBe(200);
  return trpcData<Pairing>(res);
}

const exchange = (code: string) =>
  fetch(`${server.url}/api/pair/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

const apiStatus = async (token: string) =>
  (await fetch(`${server.url}/trpc/repos.list`, { headers: bearer(token) })).status;

describe("pairing codes", () => {
  it("S2/S3: shows the same pending code again, exchanges it once, and names the same device", async () => {
    const device = await createUnpaired("iPhone");
    const first = await pairing(device.id);
    expect(first.code.startsWith("bdp_")).toBe(true);
    expect((await pairing(device.id)).code).toBe(first.code);

    // A regenerated code replaces it, and the old one stops working.
    const second = await pairing(device.id, true);
    expect(second.code).not.toBe(first.code);
    expect((await exchange(first.code)).status).toBe(401);

    const res = await exchange(second.code);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("band_token=bdt_");
    const paired = (await res.json()) as { token: string; deviceId: string; label: string };
    expect(paired).toMatchObject({ deviceId: device.id, label: "iPhone" });
    expect(await apiStatus(paired.token)).toBe(200);

    // The second use fails with the same message.
    const again = await exchange(second.code);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: string }).error).toMatch(
      /already used or has expired/,
    );

    const listed = (await listDevices()).filter((d) => d.label === "iPhone");
    expect(listed.map((d) => d.id)).toEqual([device.id]);
  });

  it("S3: the old token of a paired device stops working only at the exchange", async () => {
    const res = await trpcMutate(server.url, "tokens.createDevice", { label: "laptop" }, SHARED);
    const { token: oldToken, view } = await trpcData<{ token: string; view: TokenView }>(res);
    const code = await pairing(view.id);
    expect(await apiStatus(oldToken)).toBe(200);
    const paired = (await (await exchange(code.code)).json()) as { token: string };
    expect(await apiStatus(oldToken)).toBe(401);
    expect(await apiStatus(paired.token)).toBe(200);
  });

  it("S3: of two concurrent exchanges only one wins", async () => {
    const device = await createUnpaired("race");
    const { code } = await pairing(device.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => exchange(code)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401, 401, 401, 401]);
  });

  it("S4: refuses an expired code and leaves the device's current token working", async () => {
    const res = await trpcMutate(server.url, "tokens.createDevice", { label: "slow" }, SHARED);
    const { token, view } = await trpcData<{ token: string; view: TokenView }>(res);
    const { code, expiresAt } = await pairing(view.id);
    await new Promise((r) => setTimeout(r, Math.max(0, expiresAt - Date.now()) + 100));
    expect((await exchange(code)).status).toBe(401);
    expect(await apiStatus(token)).toBe(200);
  });

  it("serves the link page without spending the code", async () => {
    const device = await createUnpaired("prefetch");
    const { code } = await pairing(device.id);
    const page = await fetch(`${server.url}/?pair=${code}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/api/pair/exchange");
    expect((await exchange(code)).status).toBe(200);
  });

  it("does not store a pending code in the clear", async () => {
    const device = await createUnpaired("sealed");
    const { code } = await pairing(device.id);
    const db = new DatabaseSync(join(home, ".band", "band.db"), { readOnly: true });
    const rows = db
      .prepare("SELECT hash, sealed FROM tokens WHERE device_id = ?")
      .all(device.id) as {
      hash: string;
      sealed: string;
    }[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].sealed.startsWith("v1:")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(code);
  });
});

describe("revoke", () => {
  it("S1: signs the device out and removes it from the list", async () => {
    const res = await trpcMutate(server.url, "tokens.createDevice", { label: "gone" }, SHARED);
    const { token, view } = await trpcData<{ token: string; view: TokenView }>(res);
    expect(await apiStatus(token)).toBe(200);
    expect(
      (await trpcMutate(server.url, "tokens.revoke", { tokenId: view.id }, SHARED)).status,
    ).toBe(200);
    expect(await apiStatus(token)).toBe(401);
    expect((await listDevices()).some((d) => d.id === view.id)).toBe(false);
    expect(
      (await trpcMutate(server.url, "tokens.pairing", { tokenId: view.id }, SHARED)).status,
    ).toBe(404);
  });

  it("S1: deletes revoked and expired device rows left from before, and no others", async () => {
    const live = await createUnpaired("keeper");
    const db = new DatabaseSync(join(home, ".band", "band.db"));
    const insert = db.prepare(
      "INSERT INTO tokens (id, kind, hash, label, admin, created_at, expires_at, revoked_at) VALUES (?, 'device', ?, ?, 0, 1, ?, ?)",
    );
    insert.run("old-revoked", "a".repeat(64), "old revoked", null, 5);
    insert.run("old-expired", "b".repeat(64), "old expired", 10, null);
    db.close();
    const ids = (await listDevices()).map((d) => d.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain("old-revoked");
    expect(ids).not.toContain("old-expired");
    const check = new DatabaseSync(join(home, ".band", "band.db"), { readOnly: true });
    const left = check.prepare("SELECT id FROM tokens WHERE id LIKE 'old-%'").all();
    check.close();
    expect(left).toEqual([]);
  });

  it("S1: deletes pairing codes with the device", async () => {
    const device = await createUnpaired("with code");
    const { code } = await pairing(device.id);
    await trpcMutate(server.url, "tokens.revoke", { tokenId: device.id }, SHARED);
    expect((await exchange(code)).status).toBe(401);
  });
});

describe("pairing addresses", () => {
  it("S6/S8: offers the public URL, and saves and removes a custom address", async () => {
    const read = async () =>
      trpcData<{
        publicUrl: string | null;
        interfaces: Array<{ label: string; kind: string; url: string }>;
        custom: string[];
      }>(await trpcQuery(server.url, "tokens.pairingAddresses", undefined, SHARED));
    expect((await read()).publicUrl).toBe(PUBLIC_URL);
    for (const i of (await read()).interfaces) {
      expect(i.label).toMatch(/\(.+\)$/);
      expect(i.url).toMatch(/^http:\/\//);
    }

    const bad = await trpcMutate(
      server.url,
      "tokens.addPairingAddress",
      { url: "ftp://x" },
      SHARED,
    );
    expect(bad.status).toBe(400);
    const add = await trpcMutate(
      server.url,
      "tokens.addPairingAddress",
      { url: "https://custom.example.ts.net/ignored/path" },
      SHARED,
    );
    expect(add.status).toBe(200);
    expect((await read()).custom).toEqual(["https://custom.example.ts.net"]);
    await trpcMutate(
      server.url,
      "tokens.removePairingAddress",
      { url: "https://custom.example.ts.net" },
      SHARED,
    );
    expect((await read()).custom).toEqual([]);
  });
});

describe("admin only", () => {
  it("S9: a non-admin device gets 403 from the addresses, pairing and revoke procedures", async () => {
    const res = await trpcMutate(server.url, "tokens.createDevice", { label: "plain" }, SHARED);
    const { token } = await trpcData<{ token: string; view: TokenView }>(res);
    const victim = await createUnpaired("victim");
    const calls = [
      trpcQuery(server.url, "tokens.pairingAddresses", undefined, token),
      trpcMutate(server.url, "tokens.addPairingAddress", { url: "https://a.example.com" }, token),
      trpcMutate(
        server.url,
        "tokens.removePairingAddress",
        { url: "https://a.example.com" },
        token,
      ),
      trpcMutate(server.url, "tokens.createUnpairedDevice", { label: "x" }, token),
      trpcMutate(server.url, "tokens.pairing", { tokenId: victim.id }, token),
      trpcMutate(server.url, "tokens.revoke", { tokenId: victim.id }, token),
    ];
    for (const call of calls) expect((await call).status).toBe(403);
  });
});
