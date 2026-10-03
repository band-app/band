/**
 * Integration test for the hub picker's storage and validation.
 *
 * Real files under a sandboxed HOME, and a real HTTP server on its own port
 * standing in for a remote hub (it enforces the Bearer token like the hub).
 */

import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  checkRemoteHub,
  loadHubChoice,
  parseHubChoice,
  parseRemoteUrl,
  saveHubChoice,
  viewHubChoice,
} from "../src/main/services/hub-choice.ts";

describe("hub choice", () => {
  let sandboxHome: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "band-desktop-hub-choice-"));
    process.env.HOME = sandboxHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(sandboxHome, { recursive: true, force: true });
  });

  test("defaults to local with no file, and for an unreadable one", async () => {
    assert.deepEqual(loadHubChoice(), { mode: "local" });
    mkdirSync(join(sandboxHome, ".band"), { recursive: true });
    writeFileSync(join(sandboxHome, ".band", "desktop-hub.json"), "{not json");
    assert.deepEqual(loadHubChoice(), { mode: "local" });
  });

  test("a saved remote choice round-trips, and its file is private", async () => {
    saveHubChoice({ mode: "remote", url: "https://hub.example.com", token: "tok_en-1" });
    assert.deepEqual(loadHubChoice(), {
      mode: "remote",
      url: "https://hub.example.com",
      token: "tok_en-1",
    });
    const mode = (await stat(join(sandboxHome, ".band", "desktop-hub.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
    saveHubChoice({ mode: "local" });
    assert.deepEqual(loadHubChoice(), { mode: "local" });
  });

  test("the renderer's view never carries the token", () => {
    const view = viewHubChoice({ mode: "remote", url: "https://h.example", token: "secret" });
    assert.deepEqual(view, { mode: "remote", url: "https://h.example", hasToken: true });
    assert.ok(!JSON.stringify(view).includes("secret"));
  });

  test("URL rules: https anywhere, http only on loopback", () => {
    assert.deepEqual(parseRemoteUrl("https://hub.example.com/path?x=1"), {
      origin: "https://hub.example.com",
    });
    assert.deepEqual(parseRemoteUrl("http://localhost:4000"), { origin: "http://localhost:4000" });
    assert.deepEqual(parseRemoteUrl("http://127.0.0.1:4000"), { origin: "http://127.0.0.1:4000" });
    for (const bad of ["http://192.168.1.5:3456", "ftp://hub.example.com", "hub.example.com", ""]) {
      assert.ok("error" in parseRemoteUrl(bad), bad);
    }
  });

  test("a remote choice needs a URL and a token the hub's subprotocol accepts", () => {
    assert.ok("choice" in parseHubChoice({ mode: "local" }));
    assert.ok("error" in parseHubChoice({ mode: "remote", url: "https://h.example" }));
    assert.ok(
      "error" in parseHubChoice({ mode: "remote", url: "https://h.example", token: "a b" }),
    );
    assert.ok("error" in parseHubChoice({ mode: "other" }));
    assert.ok("error" in parseHubChoice(null));
    const ok = parseHubChoice({ mode: "remote", url: "https://h.example/x", token: " abc " });
    assert.deepEqual(ok, { choice: { mode: "remote", url: "https://h.example", token: "abc" } });
  });

  describe("checkRemoteHub against a hub on another port", () => {
    let hub: Server;
    let url: string;

    beforeEach(async () => {
      hub = createServer((req, res) => {
        if (req.url === "/api/health") {
          if (req.headers.authorization !== "Bearer good-token") {
            res.writeHead(401).end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", app: "band-web-server" }));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
      const addr = hub.address();
      assert.ok(addr && typeof addr !== "string");
      url = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => hub.close(() => resolve()));
    });

    test("accepts a hub that takes the token", async () => {
      assert.deepEqual(await checkRemoteHub(url, "good-token"), { ok: true });
    });

    test("reports a wrong token, a wrong server and no server", async () => {
      assert.deepEqual(await checkRemoteHub(url, "bad-token"), {
        ok: false,
        error: "The hub rejected the token",
      });
      const result = await checkRemoteHub("http://127.0.0.1:1", "good-token", 1_000);
      assert.equal(result.ok, false);
    });
  });
});
