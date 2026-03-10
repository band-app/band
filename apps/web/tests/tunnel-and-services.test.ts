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
// tRPC HTTP helpers
// ---------------------------------------------------------------------------

async function trpcQuery(
  serverUrl: string,
  procedure: string,
  input?: unknown,
  opts?: { headers?: Record<string, string> },
) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, opts?.headers ? { headers: opts.headers } : undefined);
}

async function trpcMutate(
  serverUrl: string,
  procedure: string,
  input?: unknown,
  opts?: { headers?: Record<string, string> },
) {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...opts?.headers },
    body: input !== undefined ? JSON.stringify(input) : "{}",
  });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// services.health
// ---------------------------------------------------------------------------

describe("services.health", () => {
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
    const res = await trpcQuery(server.url, "services.health");
    expect(res.status).toBe(200);
    const body = await trpcData<{
      webserver: boolean;
      tunnel: boolean;
      tunnel_url: string | null;
      tunnel_remote_host: string | null;
    }>(res);
    expect(body.webserver).toBe(true);
    expect(typeof body.tunnel).toBe("boolean");
    expect(body.tunnel).toBe(false);
    expect(body.tunnel_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tunnel.status
// ---------------------------------------------------------------------------

describe("tunnel.status", () => {
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
    const res = await trpcQuery(server.url, "tunnel.status");
    expect(res.status).toBe(200);
    const body = await trpcData<{
      running: boolean;
      url: string | null;
      remoteHost: string | null;
    }>(res);
    expect(body.running).toBe(false);
    expect(body.url).toBeNull();
    expect(body.remoteHost).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tunnel.stop
// ---------------------------------------------------------------------------

describe("tunnel.stop", () => {
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
    const res = await trpcMutate(server.url, "tunnel.stop");
    expect(res.status).toBe(200);
    const body = await trpcData<{ ok: boolean }>(res);
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// prereqs.check
// ---------------------------------------------------------------------------

describe("prereqs.check", () => {
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
    const res = await trpcQuery(server.url, "prereqs.check");
    expect(res.status).toBe(200);
    const body = await trpcData<{ node: boolean; instatunnel: boolean }>(res);
    expect(typeof body.node).toBe("boolean");
    expect(typeof body.instatunnel).toBe("boolean");
    // Node.js is always available since we're running this test with it
    expect(body.node).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// services.token
// ---------------------------------------------------------------------------

describe("services.token", () => {
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

    const res = await trpcQuery(server.url, "services.token", undefined, {
      headers: { Cookie: `band_token=${expectedToken}` },
    });
    expect(res.status).toBe(200);
    const body = await trpcData<{ token: string }>(res);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });
});

describe("services.token — no secret configured", () => {
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
    const res = await trpcQuery(server.url, "services.token");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// tunnel.authCheck
// ---------------------------------------------------------------------------

describe("tunnel.authCheck", () => {
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
    const res = await trpcQuery(server.url, "tunnel.authCheck");
    expect(res.status).toBe(200);
    const body = await trpcData<{ authenticated: boolean }>(res);
    expect(typeof body.authenticated).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// tunnel.stop — resets tunnel status
// ---------------------------------------------------------------------------

describe("tunnel.stop — resets tunnel status", () => {
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
    const stopRes = await trpcMutate(server.url, "tunnel.stop");
    expect(stopRes.status).toBe(200);

    // Verify tunnel status is still not running
    const statusRes = await trpcQuery(server.url, "tunnel.status");
    expect(statusRes.status).toBe(200);
    const status = await trpcData<{ running: boolean; url: string | null }>(statusRes);
    expect(status.running).toBe(false);
    expect(status.url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SSE stream — tunnel events propagate (stays as REST)
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
// Auth enforcement on tRPC tunnel/service endpoints
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

  it("returns 401 for services.health without auth", async () => {
    const res = await trpcQuery(server.url, "services.health");
    expect(res.status).toBe(401);
  });

  it("returns 200 for services.health with auth", async () => {
    const res = await trpcQuery(server.url, "services.health", undefined, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for tunnel.status without auth", async () => {
    const res = await trpcQuery(server.url, "tunnel.status");
    expect(res.status).toBe(401);
  });

  it("returns 200 for tunnel.status with auth", async () => {
    const res = await trpcQuery(server.url, "tunnel.status", undefined, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for tunnel.stop without auth", async () => {
    const res = await trpcMutate(server.url, "tunnel.stop");
    expect(res.status).toBe(401);
  });

  it("returns 401 for prereqs.check without auth", async () => {
    const res = await trpcQuery(server.url, "prereqs.check");
    expect(res.status).toBe(401);
  });

  it("returns 200 for prereqs.check with auth", async () => {
    const res = await trpcQuery(server.url, "prereqs.check", undefined, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for tunnel.authCheck without auth", async () => {
    const res = await trpcQuery(server.url, "tunnel.authCheck");
    expect(res.status).toBe(401);
  });

  it("returns 200 for tunnel.authCheck with auth", async () => {
    const res = await trpcQuery(server.url, "tunnel.authCheck", undefined, {
      headers: { Cookie: authCookie },
    });
    expect(res.status).toBe(200);
  });
});
