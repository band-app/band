// Integration test for installing an editor extension from a release archive: `extensions.install`
// (a URL served by a local Express stub), `POST /api/extensions/install` (an uploaded archive),
// `extensions.remove`, the refusals for an unsafe or invalid archive, and who may call them.

import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
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

const TOKEN = "extensions-install-token";

function manifest(id: string, version: string, extra: object = {}): string {
  return JSON.stringify({
    id,
    name: `Extension ${id}`,
    version,
    extensionApi: 1,
    contributes: {
      fileEditors: [{ id: "main", label: "Main", selector: ["*.demo"], entry: "index.html" }],
    },
    ...extra,
  });
}

function goodEntries(id: string, version: string): TarEntry[] {
  return [
    { name: `${id}/`, type: "5" },
    { name: `${id}/band-extension.json`, data: manifest(id, version) },
    { name: `${id}/index.html`, data: `<p>${id} ${version}</p>` },
  ];
}

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

describe("installing editor extensions", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let stub: Server;
  let stubUrl: string;
  const files = new Map<string, Buffer>();
  // Built before the server starts. Gzipping 600 MB blocks this process for seconds, and a
  // keep-alive connection left idle that long is closed by the server (5 s), so the next fetch
  // writes to a dead socket and fails with ECONNRESET. No real client blocks between requests.
  let expandingArchive: Buffer;

  const install = async (url: string, sha256?: string, token = TOKEN) =>
    trpcMutate(server.url, "extensions.install", { url, sha256 }, token);
  const upload = (body: Buffer, query = "", token = TOKEN, headers: object = {}) =>
    fetch(`${server.url}/api/extensions/install${query}`, {
      method: "POST",
      headers: { Cookie: `band_token=${token}`, ...headers },
      body,
    });
  const list = async () =>
    trpcData<{ extensions: Array<{ id: string; version: string }> }>(
      await trpcQuery(server.url, "extensions.list", undefined, TOKEN),
    );
  const installedHtml = async (id: string) =>
    (await fetch(`${server.url}/ext/${id}/index.html`)).text();
  const errorOf = async (res: Response) =>
    ((await res.json()) as { error: { message: string } }).error.message;

  beforeAll(async () => {
    // A 600 MB file of zeros compresses to well under the 200 MB archive cap.
    expandingArchive = makeTarGz([
      ...goodEntries("keep", "9.0.0"),
      { name: "keep/zeros.bin", data: Buffer.alloc(600 * 1024 * 1024) },
    ]);
    tmpHome = createTmpHome("band-ext-install-");
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
    const app = express();
    app.get("/*file", (req, res) => {
      const body = files.get(req.path);
      if (!body) {
        res.status(404).end();
        return;
      }
      res.type("application/octet-stream").send(body);
    });
    await new Promise<void>((resolve) => {
      stub = app.listen(0, "127.0.0.1", resolve);
    });
    const address = stub.address();
    stubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    stub?.close();
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10 });
  });

  it("S13: installs from a URL with its .sha256, replaces it with a newer version and removes it", async () => {
    const v1 = makeTarGz(goodEntries("demo", "1.0.0"));
    files.set("/demo-1.0.0.tar.gz", v1);
    files.set("/demo-1.0.0.tar.gz.sha256", Buffer.from(`${sha(v1)}  demo-1.0.0.tar.gz\n`));

    const res = await install(`${stubUrl}/demo-1.0.0.tar.gz`);

    expect(res.status).toBe(200);
    expect((await list()).extensions.map((e) => `${e.id}@${e.version}`)).toEqual(["demo@1.0.0"]);
    expect(await installedHtml("demo")).toBe("<p>demo 1.0.0</p>");

    const v2 = makeTarGz(goodEntries("demo", "2.0.0"));
    files.set("/demo-2.0.0.tar.gz", v2);
    expect((await install(`${stubUrl}/demo-2.0.0.tar.gz`, sha(v2))).status).toBe(200);
    expect((await list()).extensions.map((e) => e.version)).toEqual(["2.0.0"]);
    expect(await installedHtml("demo")).toBe("<p>demo 2.0.0</p>");
    // No staging or backup folder is left in the extensions folder.
    expect(existsSync(join(tmpHome, ".band", "extensions", "demo"))).toBe(true);

    const removed = await trpcMutate(server.url, "extensions.remove", { id: "demo" }, TOKEN);
    expect(removed.status).toBe(200);
    expect((await list()).extensions).toEqual([]);
    expect((await fetch(`${server.url}/ext/demo/index.html`)).status).toBe(404);
    expect((await trpcMutate(server.url, "extensions.remove", { id: "demo" }, TOKEN)).status).toBe(
      400,
    );
  });

  it("S13: installs an uploaded archive", async () => {
    const archive = makeTarGz(goodEntries("uploaded", "1.2.3"));

    const res = await upload(archive, `?sha256=${sha(archive)}`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { extension: { id: string } }).extension.id).toBe("uploaded");
    expect(await installedHtml("uploaded")).toBe("<p>uploaded 1.2.3</p>");
  });

  describe("S14: refuses an unsafe or invalid archive and keeps the installed version", () => {
    beforeAll(async () => {
      const good = makeTarGz(goodEntries("keep", "1.0.0"));
      expect((await upload(good)).status).toBe(200);
    });

    const cases: Array<[string, () => Buffer, string | undefined, RegExp]> = [
      [
        "a .. path",
        () =>
          makeTarGz([...goodEntries("keep", "9.0.0"), { name: "keep/../escape.txt", data: "x" }]),
        undefined,
        /unsafe path/,
      ],
      [
        "an absolute path",
        () => makeTarGz([...goodEntries("keep", "9.0.0"), { name: "/tmp/escape.txt", data: "x" }]),
        undefined,
        /unsafe path/,
      ],
      [
        "a symlink",
        () =>
          makeTarGz([
            ...goodEntries("keep", "9.0.0"),
            { name: "keep/link", type: "2", linkname: "/etc/passwd" },
          ]),
        undefined,
        /symlink/,
      ],
      [
        "a hard link",
        () =>
          makeTarGz([
            ...goodEntries("keep", "9.0.0"),
            { name: "keep/hard", type: "1", linkname: "keep/index.html" },
          ]),
        undefined,
        /hard link/,
      ],
      [
        "two top-level folders",
        () => makeTarGz([...goodEntries("keep", "9.0.0"), { name: "other/file.txt", data: "x" }]),
        undefined,
        /one top-level folder/,
      ],
      [
        "a folder name that differs from the manifest id",
        () =>
          makeTarGz([
            { name: "keep/band-extension.json", data: manifest("another", "9.0.0") },
            { name: "keep/index.html", data: "x" },
          ]),
        undefined,
        /does not match the manifest id/,
      ],
      [
        "an invalid manifest",
        () =>
          makeTarGz([
            { name: "keep/band-extension.json", data: manifest("keep", "9.0.0", { surprise: 1 }) },
            { name: "keep/index.html", data: "x" },
          ]),
        undefined,
        /band-extension.json/,
      ],
      [
        "a missing manifest",
        () => makeTarGz([{ name: "keep/index.html", data: "x" }]),
        undefined,
        /no band-extension.json/,
      ],
      [
        "a wrong sha256",
        () => makeTarGz(goodEntries("keep", "9.0.0")),
        "0".repeat(64),
        /does not match its sha256/,
      ],
      ["a file that is not a .tar.gz", () => Buffer.from("not an archive"), undefined, /\.tar\.gz/],
    ];

    it.each(cases)("%s", async (_name, build, sha256, message) => {
      const archive = build();
      const res = await upload(archive, sha256 ? `?sha256=${sha256}` : "");

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
      expect((await list()).extensions.find((e) => e.id === "keep")?.version).toBe("1.0.0");
      expect(await installedHtml("keep")).toBe("<p>keep 1.0.0</p>");
    });

    it("a URL whose .sha256 does not match", async () => {
      const archive = makeTarGz(goodEntries("keep", "9.0.0"));
      files.set("/bad.tar.gz", archive);
      files.set("/bad.tar.gz.sha256", Buffer.from(`${"1".repeat(64)}\n`));

      const res = await install(`${stubUrl}/bad.tar.gz`);

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatch(/sha256/);
      expect(await installedHtml("keep")).toBe("<p>keep 1.0.0</p>");
    });

    it("an upload over the size cap", async () => {
      const res = await upload(Buffer.alloc(200 * 1024 * 1024 + 1, 1));

      expect(res.status).toBe(413);
      expect(await installedHtml("keep")).toBe("<p>keep 1.0.0</p>");
    });

    it("an archive that expands past the limit", async () => {
      const res = await upload(expandingArchive);

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/size limit/);
      expect(await installedHtml("keep")).toBe("<p>keep 1.0.0</p>");
    }, 60_000);

    it("a URL that is not https and not loopback, and one that is missing", async () => {
      const insecure = await install("http://example.com/x.tar.gz");
      expect(insecure.status).toBe(400);
      expect(await errorOf(insecure)).toMatch(/https/);

      const missing = await install(`${stubUrl}/nothing.tar.gz`);
      expect(missing.status).toBe(400);
      expect(await errorOf(missing)).toMatch(/404/);
    });
  });

  describe("S15: who may install", () => {
    let deviceToken: string;

    beforeAll(async () => {
      deviceToken = (
        await trpcData<{ token: string }>(
          await trpcMutate(server.url, "tokens.createDevice", { label: "phone" }, TOKEN),
        )
      ).token;
    });

    it("refuses a non-admin device token on every route", async () => {
      const archive = makeTarGz(goodEntries("denied", "1.0.0"));
      files.set("/denied.tar.gz", archive);

      expect((await install(`${stubUrl}/denied.tar.gz`, undefined, deviceToken)).status).toBe(403);
      expect(
        (await trpcMutate(server.url, "extensions.remove", { id: "keep" }, deviceToken)).status,
      ).toBe(403);
      expect((await upload(archive, "", deviceToken)).status).toBe(403);
      expect((await list()).extensions.find((e) => e.id === "denied")).toBeUndefined();
    });

    it("refuses an agent's request, even with the admin token", async () => {
      const archive = makeTarGz(goodEntries("denied", "1.0.0"));

      const res = await upload(archive, "", TOKEN, { "x-band-chat-id": "chat_1" });

      expect(res.status).toBe(403);
      expect((await list()).extensions.find((e) => e.id === "denied")).toBeUndefined();
    });

    it("leaves the procedures out of the MCP endpoint", async () => {
      const res = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Cookie: `band_token=${TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).toContain("band_");
      expect(text).not.toMatch(/extensions_/);
    });
  });
});
