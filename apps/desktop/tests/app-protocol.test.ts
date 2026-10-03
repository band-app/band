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

import {
  appHostForHub,
  appOriginForHost,
  buildCsp,
  createAppHandler,
  isAppHost,
  LOCAL_APP_HOST,
  resolveInside,
} from "../src/main/app-protocol.ts";

describe("app:// handler", () => {
  let root: string;
  let outside: string;
  let handle: (request: Request) => Promise<Response>;
  let host = LOCAL_APP_HOST;
  let hubOrigin: string | null = "http://localhost:4567";

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
    handle = createAppHandler(root, { host: () => host, hubOrigin: () => hubOrigin });
  });

  after(async () => {
    await rm(join(root, ".."), { recursive: true, force: true });
  });

  const get = (path: string, init?: RequestInit) =>
    handle(new Request(`${appOriginForHost(host)}${path}`, init));

  test("the root path serves the shell", async () => {
    const res = await get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await res.text(), "<html>shell</html>");
    assert.equal(res.headers.get("cache-control"), "no-cache");
  });

  test("deep links and reloads inside the app get the shell (route kept)", async () => {
    for (const path of [
      "/workspace/abc",
      "/workspace/a%20b/",
      "/some/unknown/route",
      "/workspace/band-release-1.2",
    ]) {
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

  test("only GET and HEAD, and only the host the window is loaded under", async () => {
    assert.equal((await get("/", { method: "POST", body: "x" })).status, 405);
    assert.equal((await handle(new Request("app://evil/"))).status, 404);
    assert.equal((await handle(new Request("app://h-0123456789ab/"))).status, 404);
  });

  test("every response carries a CSP that names the current hub", async () => {
    for (const path of ["/", "/assets/main-abc123.js", "/workspace/x"]) {
      const csp = (await get(path)).headers.get("content-security-policy") ?? "";
      assert.match(
        csp,
        /connect-src 'self' http:\/\/localhost:4567 ws:\/\/localhost:4567(;|$)/,
        path,
      );
      assert.equal((await get(path)).headers.get("x-content-type-options"), "nosniff");
    }
  });

  test("a switch to a remote hub changes the host and the CSP", async () => {
    hubOrigin = "https://hub.example.com";
    host = appHostForHub(hubOrigin);
    try {
      assert.equal((await get("/")).status, 200);
      const csp = (await get("/")).headers.get("content-security-policy") ?? "";
      assert.match(
        csp,
        /connect-src 'self' https:\/\/hub\.example\.com wss:\/\/hub\.example\.com(;|$)/,
      );
      assert.ok(!csp.includes("localhost"));
      // The old host no longer answers.
      assert.equal((await handle(new Request("app://local/"))).status, 404);
    } finally {
      host = LOCAL_APP_HOST;
      hubOrigin = "http://localhost:4567";
    }
  });
});

describe("app hosts and CSP", () => {
  test("each hub gets its own stable host", () => {
    const a = appHostForHub("https://a.example.com");
    assert.match(a, /^h-[0-9a-f]{12}$/);
    assert.equal(a, appHostForHub("https://a.example.com"));
    assert.notEqual(a, appHostForHub("https://b.example.com"));
    assert.equal(appHostForHub(null), "local");
    assert.ok(isAppHost(a) && isAppHost("local"));
    assert.ok(!isAppHost("band") && !isAppHost("h-xyz"));
  });

  test("the CSP lets the page talk to itself only, plus its hub", () => {
    const csp = buildCsp("http://localhost:4567");
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-src 'self' blob: http:\/\/localhost:4567/);
    const none = buildCsp(null);
    assert.match(none, /connect-src 'self'(;|$)/);
  });
});
