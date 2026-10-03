/**
 * Integration test for the `app://` handler that serves the bundled UI.
 *
 * Real files in a temp directory laid out like `apps/web/dist/client`, real
 * `Request` objects. The handler imports nothing from Electron, so it runs
 * here as it does in the app.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { APP_ORIGIN, createAppHandler, resolveInside } from "../src/main/app-protocol.ts";

describe("app:// handler", () => {
  let root: string;
  let outside: string;
  let handle: (request: Request) => Promise<Response>;

  before(async () => {
    const base = await mkdtemp(join(tmpdir(), "band-desktop-app-protocol-"));
    root = join(base, "client");
    outside = join(base, "secret.txt");
    await mkdir(join(root, "assets"), { recursive: true });
    await mkdir(join(root, "icons"), { recursive: true });
    await writeFile(join(root, "_shell.html"), "<html>shell</html>");
    await writeFile(join(root, "assets", "main-abc123.js"), "console.log(1)");
    await writeFile(join(root, "icons", "band-192.png"), "png");
    await writeFile(join(root, "manifest.webmanifest"), "{}");
    await writeFile(outside, "do not serve");
    handle = createAppHandler(root);
  });

  after(async () => {
    await rm(join(root, ".."), { recursive: true, force: true });
  });

  const get = (path: string, init?: RequestInit) =>
    handle(new Request(`${APP_ORIGIN}${path}`, init));

  test("the root path serves the shell", async () => {
    const res = await get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await res.text(), "<html>shell</html>");
    assert.equal(res.headers.get("cache-control"), "no-cache");
  });

  test("deep links and reloads inside the app get the shell (route kept)", async () => {
    for (const path of ["/workspace/abc", "/workspace/a%20b/", "/some/unknown/route"]) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.equal(await res.text(), "<html>shell</html>", path);
    }
  });

  test("assets are served with their type, and hashed ones are immutable", async () => {
    const js = await get("/assets/main-abc123.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
    assert.match(js.headers.get("cache-control") ?? "", /immutable/);
    const manifest = await get("/manifest.webmanifest");
    assert.equal(manifest.headers.get("content-type"), "application/manifest+json");
    assert.equal(manifest.headers.get("cache-control"), "no-cache");
    const icon = await get("/icons/band-192.png");
    assert.equal(icon.headers.get("content-type"), "image/png");
  });

  test("a missing asset is a 404, not the shell", async () => {
    const res = await get("/assets/gone-deadbeef.js");
    assert.equal(res.status, 404);
  });

  test("paths that leave the UI directory are refused", async () => {
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const res = await get(path);
      assert.notEqual(await res.text(), "do not serve", path);
    }
    assert.equal(resolveInside(root, "/../secret.txt"), null);
    assert.equal(resolveInside(root, "/%00"), null);
    assert.equal(resolveInside(root, "/%E0%A4%A"), null);
  });

  test("only GET and HEAD, and only the band host", async () => {
    assert.equal((await get("/", { method: "POST", body: "x" })).status, 405);
    const other = await handle(new Request("app://evil/"));
    assert.equal(other.status, 404);
  });
});
