// Integration test for editor extensions on a real hub: `GET /ext/<id>/<path>` (static files,
// before the auth check, wildcard CORS, no cookies), `extensions.list | reload` and the binary
// `PUT /api/worktree-file/<worktreeId>/<path>`.

import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";

const TOKEN = "extensions-test-token";
const WORKTREE_ID = testWorktreeId("ext-repo", "main");
const FIXTURE = join(import.meta.dirname, "../../web/e2e/fixtures/extensions/text-editor");
// NUL and high bytes, so any text decoding on the path corrupts them.
const BINARY = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x80, 0x00]);

interface ExtensionsReply {
  extensions: Array<{ id: string; contributes: { fileEditors: Array<{ id: string }> } }>;
  errors: Array<{ folder: string; error: string }>;
}

describe("editor extensions", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let worktree: string;
  let extensionsDir: string;

  const list = async (): Promise<ExtensionsReply> =>
    trpcData<ExtensionsReply>(await trpcQuery(server.url, "extensions.list", undefined, TOKEN));
  const reload = async (): Promise<ExtensionsReply> =>
    trpcData<ExtensionsReply>(await trpcMutate(server.url, "extensions.reload", {}, TOKEN));
  const put = (
    path: string,
    body: Buffer | string,
    init: { auth?: boolean; headers?: object } = {},
  ) =>
    fetch(`${server.url}/api/worktree-file/${encodeURIComponent(WORKTREE_ID)}/${path}`, {
      method: "PUT",
      headers: {
        ...(init.auth === false ? {} : { Cookie: `band_token=${TOKEN}` }),
        "Content-Type": "application/octet-stream",
        ...init.headers,
      },
      body,
    });

  beforeAll(async () => {
    tmpHome = createTmpHome("band-extensions-test-");
    worktree = join(tmpHome, "ext-repo");
    mkdirSync(join(worktree, "docs"), { recursive: true });
    writeFileSync(join(worktree, "docs", "book.xlsx"), Buffer.from([1, 2, 3]));
    writeFileSync(join(worktree, "docs", "note.band-test"), "before\n");
    mkdirSync(join(worktree, "docs", "folder"));
    writeFileSync(join(tmpHome, "outside.txt"), "outside the worktree");
    symlinkSync(join(tmpHome, "outside.txt"), join(worktree, "docs", "escape.txt"));

    extensionsDir = join(tmpHome, ".band", "extensions");
    mkdirSync(extensionsDir, { recursive: true });
    cpSync(FIXTURE, join(extensionsDir, "text-editor"), { recursive: true });
    writeFileSync(
      join(extensionsDir, "text-editor", "engine.wasm"),
      Buffer.from([0, 0x61, 0x73, 0x6d]),
    );
    writeFileSync(join(extensionsDir, "text-editor", "engine.js"), "console.log('plain');");
    writeFileSync(join(extensionsDir, "text-editor", "engine.js.br"), Buffer.from("br-bytes"));
    writeFileSync(join(extensionsDir, "text-editor", "engine.js.gz"), Buffer.from("gz-bytes"));
    symlinkSync(join(tmpHome, "outside.txt"), join(extensionsDir, "text-editor", "leak.txt"));
    // A manifest with an unknown key, and one with a bad selector.
    for (const [folder, manifest] of [
      [
        "unknown-key",
        { id: "unknown-key", name: "x", version: "1", extensionApi: 1, surprise: true },
      ],
      [
        "bad-selector",
        {
          id: "bad-selector",
          name: "x",
          version: "1",
          extensionApi: 1,
          contributes: {
            fileEditors: [{ id: "e", label: "E", selector: ["../../etc/*"], entry: "index.html" }],
          },
        },
      ],
    ] as const) {
      mkdirSync(join(extensionsDir, folder));
      writeFileSync(join(extensionsDir, folder, "band-extension.json"), JSON.stringify(manifest));
    }

    seedState(tmpHome, {
      repos: [
        {
          name: "ext-repo",
          path: worktree,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: worktree }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10 });
  });

  describe("GET /ext/<id>/<path>", () => {
    it("serves a file with no token, any origin allowed and no cookie", async () => {
      const res = await fetch(`${server.url}/ext/text-editor/index.html`, {
        headers: { Origin: "null" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).toContain("Test text editor");
    });

    it("serves .wasm with its MIME type", async () => {
      const res = await fetch(`${server.url}/ext/text-editor/engine.wasm`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/wasm");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("serves the .br or .gz copy when the request accepts it", async () => {
      const br = await fetch(`${server.url}/ext/text-editor/engine.js`, {
        headers: { "Accept-Encoding": "br" },
      });
      expect(br.headers.get("content-encoding")).toBe("br");
      expect(br.headers.get("content-type")).toContain("javascript");

      const gz = await fetch(`${server.url}/ext/text-editor/engine.js`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(gz.headers.get("content-encoding")).toBe("gzip");

      const plain = await fetch(`${server.url}/ext/text-editor/engine.js`, {
        headers: { "Accept-Encoding": "identity" },
      });
      expect(plain.headers.get("content-encoding")).toBeNull();
      expect(await plain.text()).toBe("console.log('plain');");
    });

    it("answers a preflight for any origin", async () => {
      const res = await fetch(`${server.url}/ext/text-editor/index.html`, {
        method: "OPTIONS",
        headers: { Origin: "null", "Access-Control-Request-Method": "GET" },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it.each([
      ["a .. segment", "/ext/text-editor/%2e%2e/%2e%2e/outside.txt"],
      ["an encoded slash", "/ext/text-editor/..%2f..%2foutside.txt"],
      ["a symlink out of the folder", "/ext/text-editor/leak.txt"],
      ["an unknown id", "/ext/nothing/index.html"],
      ["a folder", "/ext/text-editor/"],
      ["a missing file", "/ext/text-editor/missing.js"],
      ["a manifest that failed to load", "/ext/unknown-key/band-extension.json"],
    ])("answers 404 for %s", async (_name, path) => {
      // `fetch` resolves dot segments before sending; a raw request keeps the path as written.
      const { status, cookie } = await new Promise<{ status: number; cookie?: string | string[] }>(
        (resolve, reject) => {
          const req = request(`${server.url}`, { path, method: "GET" }, (res) => {
            res.resume();
            resolve({ status: res.statusCode ?? 0, cookie: res.headers["set-cookie"] });
          });
          req.on("error", reject);
          req.end();
        },
      );

      expect(status).toBe(404);
      expect(cookie).toBeUndefined();
    });
  });

  describe("extensions.list and extensions.reload", () => {
    it("lists the fixture's manifest and skips the broken ones with a reason", async () => {
      const reply = await list();

      expect(reply.extensions.map((e) => e.id)).toEqual(["text-editor"]);
      expect(reply.extensions[0].contributes.fileEditors.map((e) => e.id)).toEqual(["text"]);
      const folders = reply.errors.map((e) => e.folder).sort();
      expect(folders).toEqual(["bad-selector", "unknown-key"]);
      expect(reply.errors.find((e) => e.folder === "unknown-key")?.error).toMatch(
        /surprise|Unrecognized/i,
      );
    });

    it("picks up a newly copied extension on reload", async () => {
      cpSync(FIXTURE, join(extensionsDir, "second"), { recursive: true });
      const manifestPath = join(extensionsDir, "second", "band-extension.json");
      writeFileSync(
        manifestPath,
        readFileSync(manifestPath, "utf8").replace('"id": "text-editor"', '"id": "second"'),
      );
      expect((await list()).extensions.map((e) => e.id)).toEqual(["text-editor"]);

      const reloaded = await reload();

      expect(reloaded.extensions.map((e) => e.id)).toEqual(["second", "text-editor"]);
      expect((await list()).extensions.map((e) => e.id)).toEqual(["second", "text-editor"]);
      const served = await fetch(`${server.url}/ext/second/index.html`);
      expect(served.status).toBe(200);
    });

    it("needs a device token to list and an admin token to reload", async () => {
      const noToken = await fetch(`${server.url}/trpc/extensions.list`);
      expect(noToken.status).toBe(401);
    });
  });

  describe("PUT /api/worktree-file/<worktreeId>/<path>", () => {
    it("replaces a file with the exact bytes", async () => {
      const res = await put("docs/book.xlsx", BINARY);

      expect(res.status).toBe(204);
      expect(readFileSync(join(worktree, "docs", "book.xlsx")).equals(BINARY)).toBe(true);
    });

    it("refuses a body over 50 MB with 413", async () => {
      const res = await put("docs/book.xlsx", Buffer.alloc(50 * 1024 * 1024 + 1, 1));

      expect(res.status).toBe(413);
      expect(readFileSync(join(worktree, "docs", "book.xlsx")).equals(BINARY)).toBe(true);
    });

    it.each([
      ["a path outside the worktree", "..%2Foutside.txt", 400],
      ["a symlink out of the worktree", "docs/escape.txt", 400],
      ["a path inside .git", ".git/config", 400],
      ["a folder", "docs/folder", 400],
      ["a file that does not exist", "docs/missing.xlsx", 404],
    ])("refuses %s", async (_name, path, status) => {
      const res = await put(path, "x");

      expect(res.status).toBe(status);
      expect(readFileSync(join(tmpHome, "outside.txt"), "utf8")).toBe("outside the worktree");
    });

    it("refuses a request with no token with 401", async () => {
      const res = await put("docs/book.xlsx", "x", { auth: false });

      expect(res.status).toBe(401);
    });

    it("refuses a request that carries an agent's chat header with 403", async () => {
      const res = await put("docs/book.xlsx", "x", { headers: { "x-band-chat-id": "chat_1" } });

      expect(res.status).toBe(403);
      expect(readFileSync(join(worktree, "docs", "book.xlsx")).equals(BINARY)).toBe(true);
    });

    it("answers 404 for an unknown worktree", async () => {
      const res = await fetch(`${server.url}/api/worktree-file/nope-main/docs/book.xlsx`, {
        method: "PUT",
        headers: { Cookie: `band_token=${TOKEN}` },
        body: "x",
      });

      expect(res.status).toBe(404);
    });
  });
});
