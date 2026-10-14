// The shared tokenSecret is an admin credential: settings.get never returns it, and only an admin
// token may change it through settings.update. Real hub on a random port with auth on.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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

const SHARED = "settings-token-secret-shared";

let home: string;
let server: ServerHandle;
let viewer: string;

const storedSecret = () =>
  (
    JSON.parse(readFileSync(join(home, ".band", "settings.json"), "utf8")) as {
      tokenSecret?: string;
    }
  ).tokenSecret;

beforeAll(async () => {
  home = createTmpHome("band-settings-token-secret-");
  seedSettings(home, { tokenSecret: SHARED });
  server = await startServer({ remoteHost: false, tmpHome: home });
  const res = await trpcMutate(server.url, "tokens.createDevice", { label: "viewer" }, SHARED);
  viewer = (await trpcData<{ token: string }>(res)).token;
}, 60_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("settings.tokenSecret", () => {
  it("is absent from settings.get for a non-admin token and for an admin token", async () => {
    for (const token of [viewer, SHARED]) {
      const res = await trpcQuery(server.url, "settings.get", undefined, token);
      expect(res.status).toBe(200);
      const settings = await trpcData<Record<string, unknown>>(res);
      expect(Object.hasOwn(settings, "tokenSecret")).toBe(false);
      expect(JSON.stringify(settings)).not.toContain(SHARED);
    }
  });

  it("refuses a non-admin settings.update that carries tokenSecret and changes nothing", async () => {
    const res = await trpcMutate(
      server.url,
      "settings.update",
      { tokenSecret: "hijacked" },
      viewer,
    );
    expect(res.status).toBe(403);
    expect(storedSecret()).toBe(SHARED);
    const still = await trpcQuery(server.url, "settings.get", undefined, SHARED);
    expect(still.status).toBe(200);
  });

  it("keeps the stored secret when an admin updates without tokenSecret", async () => {
    const res = await trpcMutate(server.url, "settings.update", { theme: "dark" }, SHARED);
    expect(res.status).toBe(200);
    expect(storedSecret()).toBe(SHARED);
  });

  it("lets a non-admin token save other settings", async () => {
    const res = await trpcMutate(server.url, "settings.update", { theme: "light" }, viewer);
    expect(res.status).toBe(200);
  });
});
