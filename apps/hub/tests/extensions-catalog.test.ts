// Integration test for the official extension catalog: `extensions.catalog` reads the index served
// by an Express stub (`BAND_EXTENSION_CATALOG_URL`), `extensions.installOfficial` installs an entry
// with its sha256 checked, and `extensions.list` marks the source of each installed extension.

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTarGz, type TarEntry } from "./helpers/make-tar";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "extensions-catalog-token";
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

function entries(id: string, version: string): TarEntry[] {
  return [
    { name: `${id}/`, type: "5" },
    {
      name: `${id}/band-extension.json`,
      data: JSON.stringify({
        id,
        name: `Extension ${id}`,
        version,
        extensionApi: 1,
        contributes: {
          fileEditors: [{ id: "main", label: "Main", selector: ["*.demo"], entry: "index.html" }],
        },
      }),
    },
    { name: `${id}/index.html`, data: `<p>${id} ${version}</p>` },
  ];
}

interface CatalogReply {
  available: boolean;
  entries: Array<{
    id: string;
    installed: string | null;
    updateAvailable: boolean;
    compatible: boolean;
    official: boolean;
  }>;
}
interface ListReply {
  sources: Array<{ id: string; official: boolean; source: string }>;
  extensions: Array<{ id: string; version: string }>;
}

describe("official extension catalog", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let stub: Server;
  let stubUrl: string;
  const files = new Map<string, Buffer>();
  let index: unknown;

  const catalog = async (token = TOKEN) =>
    trpcData<CatalogReply>(await trpcQuery(server.url, "extensions.catalog", undefined, token));
  const list = async () =>
    trpcData<ListReply>(await trpcQuery(server.url, "extensions.list", undefined, TOKEN));
  const refresh = () => trpcMutate(server.url, "extensions.refreshCatalog", {}, TOKEN);
  const installOfficial = (id: string, token = TOKEN) =>
    trpcMutate(server.url, "extensions.installOfficial", { id }, token);

  beforeAll(async () => {
    const app = express();
    app.get("/index.json", (_req, res) => res.json(index));
    app.get("/*file", (req, res) => {
      const body = files.get(req.path);
      if (!body) return void res.status(404).end();
      res.type("application/octet-stream").send(body);
    });
    await new Promise<void>((resolve) => {
      stub = app.listen(0, "127.0.0.1", resolve);
    });
    const address = stub.address();
    stubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const v1 = makeTarGz(entries("alpha", "1.0.0"));
    const v2 = makeTarGz(entries("alpha", "2.0.0"));
    files.set("/alpha-1.tar.gz", v1);
    files.set("/alpha-2.tar.gz", v2);
    files.set("/beta-1.tar.gz", makeTarGz(entries("beta", "1.0.0")));
    const entry = (id: string, version: string, file: Buffer, extra: object = {}) => ({
      id,
      name: id,
      description: `${id} extension`,
      version,
      url: `${stubUrl}/${id}-${version.split(".")[0]}.tar.gz`,
      sha256: sha(file),
      minBand: "0.0.1",
      worker: false,
      requires: [],
      ...extra,
    });
    index = [
      entry("alpha", "1.0.0", v1),
      entry("beta", "1.0.0", files.get("/beta-1.tar.gz") as Buffer, { worker: true }),
      entry("future", "1.0.0", v1, { minBand: "99.0.0" }),
      entry("badsum", "1.0.0", v1, { sha256: "0".repeat(64), url: `${stubUrl}/alpha-1.tar.gz` }),
      { id: "broken" },
    ];
    tmpHome = createTmpHome("band-ext-catalog-");
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({
      tmpHome,
      env: { BAND_EXTENSION_CATALOG_URL: `${stubUrl}/index.json` },
    });
  });

  afterAll(async () => {
    stub?.closeAllConnections();
    await new Promise<void>((done) => (stub?.listening ? stub.close(() => done()) : done()));
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10 });
  });

  it("S1: lists valid entries, skips bad ones and flags an incompatible minBand", async () => {
    await refresh();
    const reply = await catalog();
    expect(reply.available).toBe(true);
    expect(reply.entries.map((e) => e.id)).toEqual(["alpha", "beta", "future", "badsum"]);
    expect(reply.entries.find((e) => e.id === "future")?.compatible).toBe(false);
    expect(reply.entries.every((e) => e.official)).toBe(true);
  });

  it("S2: installs an entry as official, and a sha256 mismatch installs nothing", async () => {
    expect((await installOfficial("alpha")).status).toBe(200);
    expect((await list()).sources.find((s) => s.id === "alpha")).toMatchObject({
      official: true,
      source: "official",
    });
    expect((await catalog()).entries.find((e) => e.id === "alpha")?.installed).toBe("1.0.0");

    const bad = await installOfficial("badsum");
    expect(bad.status).toBe(400);
    expect((await list()).extensions.map((e) => e.id)).toEqual(["alpha"]);
    expect((await installOfficial("future")).status).toBe(400);
    expect((await installOfficial("nope")).status).toBe(400);
  });

  it("S3: offers an update when the catalog has a newer version and installs it", async () => {
    const v2 = files.get("/alpha-2.tar.gz") as Buffer;
    index = [
      {
        id: "alpha",
        name: "alpha",
        description: "",
        version: "2.0.0",
        url: `${stubUrl}/alpha-2.tar.gz`,
        sha256: sha(v2),
        minBand: "0.0.1",
      },
    ];
    await refresh();
    expect((await catalog()).entries[0]).toMatchObject({
      installed: "1.0.0",
      updateAvailable: true,
    });

    expect((await installOfficial("alpha")).status).toBe(200);
    expect((await catalog()).entries[0]).toMatchObject({
      installed: "2.0.0",
      updateAvailable: false,
    });
  });

  it("S4: an extension installed from a URL is not official", async () => {
    const other = makeTarGz(entries("gamma", "1.0.0"));
    files.set("/gamma.tar.gz", other);
    const res = await trpcMutate(
      server.url,
      "extensions.install",
      { url: `${stubUrl}/gamma.tar.gz`, sha256: sha(other) },
      TOKEN,
    );
    expect(res.status).toBe(200);
    expect((await list()).sources.find((s) => s.id === "gamma")).toMatchObject({
      official: false,
      source: "url",
    });
  });

  it("S5: a non-admin device token reads the catalog but cannot install", async () => {
    const deviceToken = (
      await trpcData<{ token: string }>(
        await trpcMutate(server.url, "tokens.createDevice", { label: "phone" }, TOKEN),
      )
    ).token;
    expect((await catalog(deviceToken)).entries.length).toBe(1);
    expect((await installOfficial("alpha", deviceToken)).status).toBe(403);
    expect(
      (await trpcMutate(server.url, "extensions.refreshCatalog", {}, deviceToken)).status,
    ).toBe(403);
  });

  it("answers 401 to the catalog procedures without a token", async () => {
    expect((await fetch(`${server.url}/trpc/extensions.catalog`)).status).toBe(401);
    for (const [procedure, input] of [
      ["extensions.installOfficial", { id: "alpha" }],
      ["extensions.refreshCatalog", {}],
    ] as const) {
      const res = await fetch(`${server.url}/trpc/${procedure}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(res.status).toBe(401);
    }
  });

  it("S6: an unreachable catalog reports unavailable and keeps the installed list", async () => {
    stub.closeAllConnections();
    stub.close();
    await refresh();
    const reply = await catalog();
    expect(reply.available).toBe(false);
    expect(reply.entries).toEqual([]);
    expect((await list()).extensions.map((e) => e.id).sort()).toEqual(["alpha", "gamma"]);
  });
});
