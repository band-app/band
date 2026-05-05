/**
 * Integration tests for the web-server lifecycle service.
 *
 * Per CLAUDE.md: black-box, real infrastructure, no mocks of our own modules.
 * We spin up a real fake `start-server.mjs` in a temp dir, set HOME so
 * settings.json reads/writes go to a sandbox, and exercise
 * `ensureWebserverRunning` end-to-end.
 *
 * The fake server:
 *   - Reads PORT from env, listens on it
 *   - Writes `tokenSecret` into `~/.band/settings.json` on startup
 *   - Responds to `/api/health?token=...` with `{ app: "band-web-server" }`
 *
 * That's exactly the contract the production server provides, so the
 * service-under-test cannot tell the difference.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  ensureWebserverRunning,
  ManagedProcess,
  parseLocalHealth,
} from "../src/main/services/web-server.ts";

// Allocate a random free port for each test so suites don't collide.
async function findFreePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("invalid address"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

const FAKE_SERVER = `import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const port = Number.parseInt(process.env.PORT ?? "0", 10);
const token = "test-token-" + Math.random().toString(36).slice(2);

// Mirror the production server: write tokenSecret on boot.
const dir = join(homedir(), ".band");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "settings.json"), JSON.stringify({ tokenSecret: token, webServerPort: port }, null, 2));

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/api/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", app: "band-web-server" }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1");

// Stay alive until SIGTERM
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`;

describe("web-server lifecycle", () => {
  let sandboxHome: string;
  let webDir: string;
  const originalHome = process.env.HOME;

  before(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "band-desktop-test-"));
    process.env.HOME = sandboxHome;

    // Lay out the fake web bundle so `webDir/dist/start-server.mjs` exists.
    webDir = join(sandboxHome, "web");
    await mkdir(join(webDir, "dist"), { recursive: true });
    await writeFile(join(webDir, "dist/start-server.mjs"), FAKE_SERVER);
  });

  after(async () => {
    process.env.HOME = originalHome;
    await rm(sandboxHome, { recursive: true, force: true });
  });

  test("parseLocalHealth recognises the production server", () => {
    assert.equal(
      parseLocalHealth('{"status":"ok","app":"band-web-server","hostname":"box.local"}'),
      true,
    );
  });

  test("parseLocalHealth rejects other apps", () => {
    assert.equal(parseLocalHealth('{"status":"ok","app":"other-server"}'), false);
  });

  test("parseLocalHealth rejects non-JSON", () => {
    assert.equal(parseLocalHealth("not json"), false);
    assert.equal(parseLocalHealth("<html>Unauthorized</html>"), false);
    assert.equal(parseLocalHealth(""), false);
  });

  test("ensureWebserverRunning spawns, polls, and returns {port, token}", async () => {
    const port = await findFreePort();
    const managed = new ManagedProcess();

    try {
      const result = await ensureWebserverRunning({ webDir, managed, port });
      assert.equal(result.port, port);
      assert.match(result.token, /^test-token-/);
      assert.equal(managed.isRunning(), true);

      // Hit the server one more time to verify it's actually alive.
      const res = await fetch(`http://127.0.0.1:${port}/api/health?token=${result.token}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.app, "band-web-server");
    } finally {
      await managed.kill();
    }
  });

  test("ManagedProcess.kill() actually frees the port", async () => {
    const port = await findFreePort();
    const managed = new ManagedProcess();

    await ensureWebserverRunning({ webDir, managed, port });
    assert.equal(managed.isRunning(), true);

    await managed.kill();
    assert.equal(managed.isRunning(), false);

    // A fresh server should now be able to bind to the same port.
    const net = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => {
        probe.close((err) => (err ? reject(err) : resolve()));
      });
    });
  });
});
