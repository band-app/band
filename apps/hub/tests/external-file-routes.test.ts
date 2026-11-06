// Integration test for the routes behind an external tab's previews (a file outside any worktree):
// `GET /api/external-file/<worktreeId>?path=` streams the bytes with Range support for a device
// token, and `worktree.externalPreviewUrl` hands out a folder grant for
// `/api/external-preview/<worktreeId>/<grant>/<path>` that a sandboxed iframe loads HTML and its
// assets from. Run with `BAND_TEST_HOST=remote-loopback` the bytes come from a real worker.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { removeTmpHome } from "./helpers/tmp-home";

const TOKEN = "external-file-routes-token";
const SITE_ID = testWorktreeId("site", "main");
const OTHER_ID = testWorktreeId("other", "main");
const VIDEO = Buffer.from(Array.from({ length: 200 }, (_, i) => i));

/** A GET whose path reaches the server as written (fetch would resolve `..` first). */
function rawGet(
  server: ServerHandle,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(server.url);
    const req = request({ host: url.hostname, port: url.port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("external file routes", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let ext: string;
  let elsewhere: string;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const fileUrl = (path: string, id = SITE_ID) =>
    `/api/external-file/${encodeURIComponent(id)}?path=${encodeURIComponent(path)}`;

  async function previewPath(path: string, id = SITE_ID): Promise<string> {
    const res = await trpcQuery(
      server.url,
      "worktree.externalPreviewUrl",
      { worktreeId: id, absolutePath: path },
      TOKEN,
    );
    expect(res.status).toBe(200);
    return (await trpcData<{ url: string }>(res)).url;
  }

  beforeAll(async () => {
    tmpHome = createTmpHome("band-external-file-routes-");
    const site = join(tmpHome, "site");
    const other = join(tmpHome, "other");
    mkdirSync(site, { recursive: true });
    mkdirSync(other, { recursive: true });
    ext = realpathSync(mkdtempSync(join(tmpdir(), "band-ext-files-")));
    elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "band-ext-elsewhere-")));
    mkdirSync(join(ext, "sub"));
    writeFileSync(join(ext, "clip.mp4"), VIDEO);
    writeFileSync(join(ext, "index.html"), '<link rel="stylesheet" href="style.css">hi');
    writeFileSync(join(ext, "style.css"), "body{color:red}");
    writeFileSync(join(ext, "sub", "deep.txt"), "deep");
    writeFileSync(join(elsewhere, "secret.txt"), "secret");
    symlinkSync(join(elsewhere, "secret.txt"), join(ext, "leak.txt"));
    symlinkSync(elsewhere, join(ext, "out"));
    mkdirSync(join(elsewhere, "other-site"));
    writeFileSync(join(elsewhere, "other-site", "index.html"), "other site");
    seedState(tmpHome, {
      repos: [
        {
          name: "site",
          path: site,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: site }],
        },
        {
          name: "other",
          path: other,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: other }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    removeTmpHome(tmpHome);
    rmSync(ext, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  describe("GET /api/external-file", () => {
    it("streams the whole file, and answers 206 and 416 for ranges", async () => {
      const whole = await rawGet(server, fileUrl(join(ext, "clip.mp4")), auth);
      expect(whole.status).toBe(200);
      expect(whole.headers["content-type"]).toBe("video/mp4");
      expect(whole.headers["accept-ranges"]).toBe("bytes");
      expect(whole.body.equals(VIDEO)).toBe(true);

      const part = await rawGet(server, fileUrl(join(ext, "clip.mp4")), {
        ...auth,
        Range: "bytes=10-19",
      });
      expect(part.status).toBe(206);
      expect(part.headers["content-range"]).toBe("bytes 10-19/200");
      expect(part.body.equals(VIDEO.subarray(10, 20))).toBe(true);

      const past = await rawGet(server, fileUrl(join(ext, "clip.mp4")), {
        ...auth,
        Range: "bytes=500-600",
      });
      expect(past.status).toBe(416);
      expect(past.headers["content-range"]).toBe("bytes */200");
    });

    it("needs a device token", async () => {
      expect((await rawGet(server, fileUrl(join(ext, "clip.mp4")))).status).toBe(401);
      expect(
        (await rawGet(server, fileUrl(join(ext, "clip.mp4")), { Authorization: "Bearer nope" }))
          .status,
      ).toBe(401);
    });

    it("refuses an agent's request", async () => {
      for (const header of ["x-band-chat-id", "x-band-worktree-id", "x-band-terminal-id"]) {
        const res = await rawGet(server, fileUrl(join(ext, "clip.mp4")), {
          ...auth,
          [header]: "anything",
        });
        expect(res.status).toBe(403);
      }
    });

    it("refuses a link, a folder, a relative path and a missing file", async () => {
      expect((await rawGet(server, fileUrl(join(ext, "leak.txt")), auth)).status).toBe(400);
      expect((await rawGet(server, fileUrl(join(ext, "sub")), auth)).status).toBe(400);
      expect((await rawGet(server, fileUrl("clip.mp4"), auth)).status).toBe(400);
      expect((await rawGet(server, fileUrl(`${ext}/../clip.mp4`), auth)).status).toBe(400);
      expect((await rawGet(server, fileUrl(join(ext, "nope.mp4")), auth)).status).toBe(404);
      expect((await rawGet(server, fileUrl(join(ext, "clip.mp4"), "no-such"), auth)).status).toBe(
        404,
      );
    });
  });

  describe("GET /api/external-preview", () => {
    it("serves the page and the files beside it with no auth header", async () => {
      const url = await previewPath(join(ext, "index.html"));
      const page = await rawGet(server, url);
      expect(page.status).toBe(200);
      expect(page.headers["content-security-policy"]).toContain("sandbox allow-scripts");
      expect(page.body.toString()).toContain("style.css");

      const css = await rawGet(server, url.replace("index.html", "style.css"));
      expect(css.status).toBe(200);
      expect(css.headers["content-type"]).toContain("text/css");
      expect(css.body.toString()).toBe("body{color:red}");

      const deep = await rawGet(server, url.replace("index.html", "sub/deep.txt"));
      expect(deep.body.toString()).toBe("deep");
    });

    it("refuses anything outside the granted folder", async () => {
      const url = await previewPath(join(ext, "index.html"));
      const grantPrefix = url.match(/^(\/api\/external-preview\/[^/]+\/[^/]+)\//)?.[1] ?? "";
      expect(grantPrefix).not.toBe("");

      const secretPath = elsewhere.slice(1).split("/").map(encodeURIComponent).join("/");
      expect((await rawGet(server, `${grantPrefix}/${secretPath}/secret.txt`)).status).toBe(403);
      expect((await rawGet(server, url.replace("index.html", "../secret.txt"))).status).toBe(403);
      expect((await rawGet(server, url.replace("index.html", "%2e%2e/secret.txt"))).status).toBe(
        403,
      );
      expect((await rawGet(server, url.replace("index.html", "sub%2Fdeep.txt"))).status).toBe(400);
      // A link inside the folder that points out of it.
      expect((await rawGet(server, url.replace("index.html", "leak.txt"))).status).toBe(400);
      expect((await rawGet(server, url.replace("index.html", "out/secret.txt"))).status).toBe(403);
    });

    it("refuses another folder's grant, another worktree's, and a tampered or expired one", async () => {
      const url = await previewPath(join(ext, "index.html"));
      const otherSite = await previewPath(join(elsewhere, "other-site", "index.html"));
      expect((await rawGet(server, otherSite)).status).toBe(200);
      // The other folder's grant applied to this folder's file.
      const crossed = url.replace(
        /\/\d+\.[^/]+\.[0-9a-f]{64}\//,
        otherSite.match(/\/\d+\.[^/]+\.[0-9a-f]{64}\//)?.[0] ?? "/x/",
      );
      expect((await rawGet(server, crossed)).status).toBe(403);

      const otherWorktree = url.replace(encodeURIComponent(SITE_ID), encodeURIComponent(OTHER_ID));
      expect((await rawGet(server, otherWorktree)).status).toBe(403);

      expect((await rawGet(server, url.replace(/\/\d{10,}\./, "/1000."))).status).toBe(403);
      expect(
        (await rawGet(server, url.replace(/\.[0-9a-f]{64}\//, `.${"0".repeat(64)}/`))).status,
      ).toBe(403);
    });

    it("mints only for an existing worktree and an absolute path, with a device token", async () => {
      const relative = await trpcQuery(
        server.url,
        "worktree.externalPreviewUrl",
        { worktreeId: SITE_ID, absolutePath: "relative/index.html" },
        TOKEN,
      );
      expect(relative.status).toBe(400);
      const noWorktree = await trpcQuery(
        server.url,
        "worktree.externalPreviewUrl",
        { worktreeId: "no-such", absolutePath: join(ext, "index.html") },
        TOKEN,
      );
      expect(noWorktree.status).toBe(404);
      const noAuth = await trpcQuery(
        server.url,
        "worktree.externalPreviewUrl",
        { worktreeId: SITE_ID, absolutePath: join(ext, "index.html") },
        "wrong",
      );
      expect(noAuth.status).toBe(401);
    });
  });
});
