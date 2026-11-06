/**
 * `LocalPreviewRegistry` shows a local HTML file's folder under `app://`. It takes a path from
 * the renderer and a URL path from the page, so the folder limits are the contract: no `..`, no
 * link out, no other folder, no expired grant. It reads a temp dir with plain `node:fs` and
 * imports no Electron.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createAppHandler } from "../src/main/app-protocol.ts";
import { LocalPreviewRegistry } from "../src/main/services/local-preview.ts";

let dir: string;
let outside: string;
before(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "band-local-preview-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "band-local-outside-")));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "index.html"), "<link rel=stylesheet href=style.css>");
  writeFileSync(join(dir, "style.css"), "body{color:red}");
  writeFileSync(join(dir, "sub", "deep.txt"), "deep");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"));
  symlinkSync(outside, join(dir, "out"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("LocalPreviewRegistry", () => {
  test("serves the page and the files beside it with sandbox headers", async () => {
    const registry = new LocalPreviewRegistry();
    const { path } = await registry.grant(join(dir, "index.html"));
    const page = await registry.serve(path);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/);

    const css = await registry.serve(path.replace("index.html", "style.css"));
    assert.equal(await css.text(), "body{color:red}");
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    const deep = await registry.serve(path.replace("index.html", "sub/deep.txt"));
    assert.equal(await deep.text(), "deep");
  });

  test("refuses anything outside the folder", async () => {
    const registry = new LocalPreviewRegistry();
    const { path } = await registry.grant(join(dir, "index.html"));
    for (const bad of [
      "../secret.txt",
      "%2e%2e/secret.txt",
      "sub%2Fdeep.txt",
      "leak.txt",
      "out/secret.txt",
    ]) {
      const res = await registry.serve(path.replace("index.html", bad));
      assert.ok(res.status === 403 || res.status === 404, `${bad} gave ${res.status}`);
      assert.notEqual(await res.text(), "secret");
    }
  });

  test("refuses an unknown token and an expired grant", async () => {
    let now = 1_000;
    const registry = new LocalPreviewRegistry(() => now);
    const { path } = await registry.grant(join(dir, "index.html"));
    assert.equal(
      (await registry.serve(path.replace(/\/[0-9a-f]{32}\//, "/deadbeef/"))).status,
      404,
    );
    now += 2 * 60 * 60 * 1000;
    assert.equal((await registry.serve(path)).status, 404);
  });

  test("refuses to grant a relative path, a missing file, a folder and a symlink", async () => {
    const registry = new LocalPreviewRegistry();
    await assert.rejects(registry.grant("index.html"), /Absolute path required/);
    await assert.rejects(registry.grant(join(dir, "nope.html")), /File not found/);
    await assert.rejects(registry.grant(join(dir, "sub")), /Not a regular file/);
    await assert.rejects(registry.grant(join(dir, "leak.txt")), /Symbolic links/);
  });

  test("the app:// handler hands the preview prefix to the registry", async () => {
    const registry = new LocalPreviewRegistry();
    const { path } = await registry.grant(join(dir, "index.html"));
    const handler = createAppHandler(dir, {
      host: () => "local",
      hubOrigin: () => null,
      localPreview: (pathname) => registry.serve(pathname),
    });
    const res = await handler(new Request(`app://local${path}`));
    assert.equal(res.status, 200);
    const withoutRegistry = createAppHandler(dir, { host: () => "local", hubOrigin: () => null });
    assert.equal((await withoutRegistry(new Request(`app://local${path}`))).status, 404);
  });
});
