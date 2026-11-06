/**
 * Settings > Extensions, official catalog: entries from an Express stub (`BAND_EXTENSION_CATALOG_URL`),
 * install and update with the sha256 checked, an incompatible entry, and an unreachable catalog.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { makeTarGz, type TarEntry } from "../../hub/tests/helpers/make-tar";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { trpcMutate } from "./helpers/trpc";
import { ExtensionsSettingsPage } from "./pages/ExtensionsSettingsPage";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-settings-extensions-catalog-token";
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

function archive(id: string, version: string): Buffer {
  const entries: TarEntry[] = [
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
    { name: `${id}/index.html`, data: "<p>x</p>" },
  ];
  return makeTarGz(entries);
}

const files = new Map<string, Buffer>();
let index: unknown[] = [];
let stub: Server;
let stubUrl: string;
let server: ServerHandle;
let tmpHome: string;
let unreachable: { server: ServerHandle; tmpHome: string };

function entry(id: string, version: string, extra: object = {}) {
  const body = archive(id, version);
  files.set(`/${id}-${version}.tar.gz`, body);
  return {
    id,
    name: `Extension ${id}`,
    description: `${id} description`,
    version,
    url: `${stubUrl}/${id}-${version}.tar.gz`,
    sha256: sha(body),
    minBand: "0.0.1",
    worker: false,
    requires: [],
    ...extra,
  };
}

test.beforeAll(async () => {
  stub = createServer((req, res) => {
    if (req.url === "/index.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(index));
      return;
    }
    const body = files.get(req.url ?? "");
    if (body) {
      res.writeHead(200, { "Content-Type": "application/gzip" });
      res.end(body);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  index = initialIndex();
  server = await startServer({
    tmpHome,
    env: { BAND_EXTENSION_CATALOG_URL: `${stubUrl}/index.json` },
  });

  const dead = createServer();
  await new Promise<void>((done) => dead.listen(0, "127.0.0.1", done));
  const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}/index.json`;
  await new Promise<void>((done) => dead.close(() => done()));

  const home2 = createTmpHome();
  seedSettings(home2, { tokenSecret: TOKEN });
  unreachable = {
    tmpHome: home2,
    server: await startServer({
      tmpHome: home2,
      env: { BAND_EXTENSION_CATALOG_URL: deadUrl },
    }),
  };
});

const initialIndex = () => [
  entry("alpha", "1.0.0", { worker: true }),
  entry("beta", "1.0.0", { minBand: "99.0.0" }),
  { ...entry("tampered", "1.0.0"), sha256: "0".repeat(64) },
];

test.beforeEach(async () => {
  resetClientState(tmpHome);
  index = initialIndex();
  for (const id of ["alpha", "tampered"]) {
    // "No extension is installed" is the state we want, so a refusal here is fine.
    await trpcMutate(server.url, TOKEN, "extensions.remove", { id }).catch(() => {});
  }
  await trpcMutate(server.url, TOKEN, "extensions.refreshCatalog", {});
});

test.afterAll(async () => {
  await new Promise<void>((done) => stub.close(() => done()));
  await server.close();
  await unreachable.server.close();
  cleanupTmpHome(tmpHome);
  cleanupTmpHome(unreachable.tmpHome);
});

function pages(page: import("@playwright/test").Page, target = server) {
  const settings = new SettingsPage(page, target.url, TOKEN);
  return new ExtensionsSettingsPage(page, settings);
}

for (const [label, viewport] of [
  ["desktop", { width: 1600, height: 900 }],
  ["phone width", { width: 390, height: 844 }],
] as const) {
  test(`S1: the catalog lists entries with Install and an incompatible one without a button (${label})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const ext = pages(page);
    await ext.open();
    await expect(ext.officialRow("alpha")).toBeVisible();
    await expect(ext.officialRow("beta")).toBeVisible();
    await expect(ext.officialInstallButton("alpha")).toHaveAttribute("data-state", "install");
    await expect(ext.officialState("beta")).toHaveAttribute("data-state", "incompatible");
    await expect(ext.officialInstallButton("beta")).toHaveCount(0);
  });
}

test("S2 and S3: install, a sha256 mismatch, then update to a newer version", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const ext = pages(page);
  await ext.open();

  await ext.officialInstallButton("alpha").click();
  await expect(ext.officialWorkerNote).toBeVisible();
  await ext.confirmOfficial();
  await expect(ext.officialState("alpha")).toHaveAttribute("data-state", "installed");
  await expect(ext.row("alpha")).toBeVisible();
  await expect(ext.source("alpha")).toHaveAttribute("data-source", "official");

  await ext.installOfficial("tampered");
  await ext.installError();
  await expect(ext.row("tampered")).toHaveCount(0);

  index = [entry("alpha", "2.0.0")];
  await ext.reloadButton.click();
  await expect(ext.officialInstallButton("alpha")).toHaveAttribute("data-state", "update");
  await ext.installOfficial("alpha");
  await expect(ext.version("alpha")).toHaveText("2.0.0");
  await expect(ext.officialState("alpha")).toHaveAttribute("data-state", "installed");
});

test("S6: an unreachable catalog shows a quiet note and the installed list", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const ext = pages(page, unreachable.server);
  await ext.open();
  await expect(ext.catalogUnavailable).toBeVisible();
  await expect(ext.urlInput).toBeVisible();
});
