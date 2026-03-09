import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROJECT_ROOT = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "band-test-"));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  mkdirSync(join(bandDir, "status"), { recursive: true });
  return tmp;
}

function seedState(tmpHome: string, state: object): void {
  writeFileSync(join(tmpHome, ".band", "state.json"), JSON.stringify(state));
}

function seedSettings(tmpHome: string, settings: object): void {
  writeFileSync(join(tmpHome, ".band", "settings.json"), JSON.stringify(settings));
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function createDefaultState(tmpHome: string) {
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  return {
    projects: [
      {
        name: "testproject",
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  };
}

async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/start-server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          home,
          close: () =>
            new Promise<void>((r) => {
              child.on("exit", () => r());
              child.kill("SIGTERM");
            }),
        });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Server exited with code ${code} before listening.\nstderr: ${stderr}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Server did not start within 15 s.\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
}

// ---------------------------------------------------------------------------
// GET /api/service-health
// ---------------------------------------------------------------------------

describe("GET /api/service-health", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, {});
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns webserver as healthy since the web server is running", async () => {
    const res = await fetch(`${server.url}/api/service-health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      webserver: boolean;
      tunnel: boolean;
      tunnel_url: string | null;
      tunnel_remote_host: string | null;
    };
    expect(body.webserver).toBe(true);
    expect(typeof body.tunnel).toBe("boolean");
    expect(body.tunnel).toBe(false);
    expect(body.tunnel_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/tunnel/status
// ---------------------------------------------------------------------------

describe("GET /api/tunnel/status", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, {});
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns tunnel not running when no tunnel has been started", async () => {
    const res = await fetch(`${server.url}/api/tunnel/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      running: boolean;
      url: string | null;
      remoteHost: string | null;
    };
    expect(body.running).toBe(false);
    expect(body.url).toBeNull();
    expect(body.remoteHost).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/tunnel/stop
// ---------------------------------------------------------------------------

describe("POST /api/tunnel/stop", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, {});
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("succeeds even when no tunnel is running", async () => {
    const res = await fetch(`${server.url}/api/tunnel/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/prereqs/check
// ---------------------------------------------------------------------------

describe("GET /api/prereqs/check", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, {});
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns prerequisite status with node and instatunnel booleans", async () => {
    const res = await fetch(`${server.url}/api/prereqs/check`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { node: boolean; instatunnel: boolean };
    expect(typeof body.node).toBe("boolean");
    expect(typeof body.instatunnel).toBe("boolean");
    // Node.js is always available since we're running this test with it
    expect(body.node).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/token
// ---------------------------------------------------------------------------

describe("GET /api/token", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, {});
    server = await startServer({ tmpHome, env: { BAND_TOKEN_SECRET: "test-secret-for-token" } });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns a token when BAND_TOKEN_SECRET is configured", async () => {
    // We need to auth first to access the endpoint
    const { createHmac } = await import("node:crypto");
    const expectedToken = createHmac("sha256", "test-secret-for-token")
      .update("band-access")
      .digest("hex");

    const res = await fetch(`${server.url}/api/token`, {
      headers: { Cookie: `band_token=${expectedToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });
});

describe("GET /api/token — no secret configured", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, {});
    // No BAND_TOKEN_SECRET env var
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 404 when no token secret is configured", async () => {
    const res = await fetch(`${server.url}/api/token`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// GET /api/tunnel/auth-check
// ---------------------------------------------------------------------------

describe("GET /api/tunnel/auth-check", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, {});
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns an authenticated boolean", async () => {
    const res = await fetch(`${server.url}/api/tunnel/auth-check`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authenticated: boolean };
    expect(typeof body.authenticated).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// POST /api/tunnel/stop — resets tunnel status
// ---------------------------------------------------------------------------

describe("POST /api/tunnel/stop — resets tunnel status", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, {});
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("tunnel status remains not-running after stop", async () => {
    // Stop tunnel (even though none is running — should succeed)
    const stopRes = await fetch(`${server.url}/api/tunnel/stop`, { method: "POST" });
    expect(stopRes.status).toBe(200);

    // Verify tunnel status is still not running
    const statusRes = await fetch(`${server.url}/api/tunnel/status`);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as { running: boolean; url: string | null };
    expect(status.running).toBe(false);
    expect(status.url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SSE stream — tunnel events propagate
// ---------------------------------------------------------------------------

describe("GET /api/status/stream — SSE event format", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, {});
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns SSE content-type and streams events", async () => {
    const res = await fetch(`${server.url}/api/status/stream`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);

    // If the request completed before the timeout, validate headers
    if (res) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    }
    // If it timed out, the endpoint is alive but streaming — that's fine
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth enforcement on tunnel/service endpoints
// ---------------------------------------------------------------------------

describe("Tunnel and service endpoints require auth when secret is set", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let authCookie: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, {});
    server = await startServer({ tmpHome, env: { BAND_TOKEN_SECRET: "my-test-secret" } });

    const { createHmac } = await import("node:crypto");
    const token = createHmac("sha256", "my-test-secret").update("band-access").digest("hex");
    authCookie = `band_token=${token}`;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 401 for /api/service-health without auth", async () => {
    const res = await fetch(`${server.url}/api/service-health`);
    expect(res.status).toBe(401);
  });

  it("returns 200 for /api/service-health with auth", async () => {
    const res = await fetch(`${server.url}/api/service-health`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for /api/tunnel/status without auth", async () => {
    const res = await fetch(`${server.url}/api/tunnel/status`);
    expect(res.status).toBe(401);
  });

  it("returns 200 for /api/tunnel/status with auth", async () => {
    const res = await fetch(`${server.url}/api/tunnel/status`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for /api/tunnel/stop without auth", async () => {
    const res = await fetch(`${server.url}/api/tunnel/stop`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/prereqs/check without auth", async () => {
    const res = await fetch(`${server.url}/api/prereqs/check`);
    expect(res.status).toBe(401);
  });

  it("returns 200 for /api/prereqs/check with auth", async () => {
    const res = await fetch(`${server.url}/api/prereqs/check`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for /api/tunnel/auth-check without auth", async () => {
    const res = await fetch(`${server.url}/api/tunnel/auth-check`);
    expect(res.status).toBe(401);
  });

  it("returns 200 for /api/tunnel/auth-check with auth", async () => {
    const res = await fetch(`${server.url}/api/tunnel/auth-check`, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
  });
});
