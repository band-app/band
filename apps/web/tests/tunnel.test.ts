import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "test-tunnel-token";

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
  return tmp;
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

/**
 * Create a fake cloudflared script that prints output matching the real CLI
 * format (URL printed to stderr) then sleeps so the process stays alive.
 */
function createFakeCloudflared(binDir: string, subdomain: string): void {
  const script = `#!/bin/sh
# Simulate cloudflared tunnel startup output on stderr
echo "2024-01-01T00:00:00Z INF Starting tunnel" >&2
echo "2024-01-01T00:00:00Z INF +-------------------------------------------+" >&2
echo "2024-01-01T00:00:00Z INF |  https://${subdomain}.trycloudflare.com    |" >&2
echo "2024-01-01T00:00:00Z INF +-------------------------------------------+" >&2
# Keep running until killed
while true; do sleep 1; done
`;
  const scriptPath = join(binDir, "cloudflared");
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
}

/**
 * Create a fake cloudflared that exits with an error.
 */
function createFakeCloudflaredError(binDir: string): void {
  const script = `#!/bin/sh
echo "failed to connect to edge" >&2
exit 1
`;
  const scriptPath = join(binDir, "cloudflared");
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
}

/**
 * Create a fake cloudflared that prints a URL then crashes after a delay.
 */
function createFakeCloudflaredCrash(binDir: string, subdomain: string, delaySecs: number): void {
  const script = `#!/bin/sh
echo "2024-01-01T00:00:00Z INF Starting tunnel" >&2
echo "2024-01-01T00:00:00Z INF +-------------------------------------------+" >&2
echo "2024-01-01T00:00:00Z INF |  https://${subdomain}.trycloudflare.com    |" >&2
echo "2024-01-01T00:00:00Z INF +-------------------------------------------+" >&2
sleep ${delaySecs}
echo "2024-01-01T00:00:00Z ERR connection lost" >&2
exit 1
`;
  const scriptPath = join(binDir, "cloudflared");
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
}

async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
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
// tRPC helpers
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

async function waitFor(
  fn: () => Promise<boolean>,
  { timeout = 10_000, interval = 100 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("Timed out");
}

function authCookie(token: string): string {
  return `band_token=${token}`;
}

// ---------------------------------------------------------------------------
// Tests: tunnel URL parsing with cloudflared output
// ---------------------------------------------------------------------------

describe("tunnel.start — parses URL from cloudflared stderr output", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    const binDir = join(tmpHome, "bin");
    mkdirSync(binDir, { recursive: true });
    createFakeCloudflared(binDir, "test-abc-123");

    server = await startServer({
      tmpHome,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        SHELL: "/bin/sh",
      },
    });
  });

  afterAll(async () => {
    // Stop tunnel first so the fake process is cleaned up
    await trpcMutate(server.url, "tunnel.stop", undefined, {
      headers: { Cookie: authCookie(DEFAULT_TOKEN) },
    }).catch(() => {});
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("starts tunnel and extracts trycloudflare.com URL", async () => {
    const res = await trpcMutate(
      server.url,
      "tunnel.start",
      {},
      {
        headers: { Cookie: authCookie(DEFAULT_TOKEN) },
      },
    );
    expect(res.status).toBe(200);

    // Wait for tunnel status to report running with URL
    await waitFor(async () => {
      const statusRes = await trpcQuery(server.url, "tunnel.status", undefined, {
        headers: { Cookie: authCookie(DEFAULT_TOKEN) },
      });
      const status = await trpcData<{ running: boolean; url: string | null }>(statusRes);
      return status.running && status.url !== null;
    });

    const statusRes = await trpcQuery(server.url, "tunnel.status", undefined, {
      headers: { Cookie: authCookie(DEFAULT_TOKEN) },
    });
    const status = await trpcData<{ running: boolean; url: string | null }>(statusRes);

    expect(status.running).toBe(true);
    expect(status.url).toContain("https://test-abc-123.trycloudflare.com");
  });
});

// ---------------------------------------------------------------------------
// Tests: tunnel.start returns URL directly in response
// ---------------------------------------------------------------------------

describe("tunnel.start — returns URL in mutation response", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    const binDir = join(tmpHome, "bin");
    mkdirSync(binDir, { recursive: true });
    createFakeCloudflared(binDir, "directurl-test");

    server = await startServer({
      tmpHome,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        SHELL: "/bin/sh",
      },
    });
  });

  afterAll(async () => {
    await trpcMutate(server.url, "tunnel.stop", undefined, {
      headers: { Cookie: authCookie(DEFAULT_TOKEN) },
    }).catch(() => {});
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("mutation response includes the tunnel URL", async () => {
    const res = await trpcMutate(
      server.url,
      "tunnel.start",
      {},
      {
        headers: { Cookie: authCookie(DEFAULT_TOKEN) },
      },
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; url: string | null }>(res);
    expect(data.ok).toBe(true);
    expect(data.url).toContain("https://directurl-test.trycloudflare.com");
  });
});

// ---------------------------------------------------------------------------
// Tests: cloudflared error — resolves without crashing
// ---------------------------------------------------------------------------

describe("tunnel.start — cloudflared error returns null URL", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    const binDir = join(tmpHome, "bin");
    mkdirSync(binDir, { recursive: true });
    createFakeCloudflaredError(binDir);

    server = await startServer({
      tmpHome,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        SHELL: "/bin/sh",
      },
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 200 with null URL when cloudflared fails", async () => {
    const res = await trpcMutate(
      server.url,
      "tunnel.start",
      {},
      {
        headers: { Cookie: authCookie(DEFAULT_TOKEN) },
      },
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; url: string | null }>(res);
    expect(data.ok).toBe(true);
    expect(data.url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: services.health — with running local tunnel process
// ---------------------------------------------------------------------------

describe("services.health — with running local tunnel process", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    const binDir = join(tmpHome, "bin");
    mkdirSync(binDir, { recursive: true });
    createFakeCloudflared(binDir, "healthcheck-test");

    server = await startServer({
      tmpHome,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        SHELL: "/bin/sh",
      },
    });
  });

  afterAll(async () => {
    await trpcMutate(server.url, "tunnel.stop", undefined, {
      headers: { Cookie: authCookie(DEFAULT_TOKEN) },
    }).catch(() => {});
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reports tunnel URL via services.health after tunnel starts", async () => {
    // Start the tunnel
    await trpcMutate(
      server.url,
      "tunnel.start",
      {},
      {
        headers: { Cookie: authCookie(DEFAULT_TOKEN) },
      },
    );

    // Wait for tunnel to be running
    await waitFor(async () => {
      const res = await trpcQuery(server.url, "tunnel.status", undefined, {
        headers: { Cookie: authCookie(DEFAULT_TOKEN) },
      });
      const status = await trpcData<{ running: boolean; url: string | null }>(res);
      return status.running && status.url !== null;
    });

    // Now check services.health — it should report the tunnel as running with URL
    const healthRes = await trpcQuery(server.url, "services.health", undefined, {
      headers: { Cookie: authCookie(DEFAULT_TOKEN) },
    });
    expect(healthRes.status).toBe(200);
    const health = await trpcData<{
      webserver: boolean;
      tunnel: boolean;
      tunnel_url: string | null;
    }>(healthRes);
    expect(health.webserver).toBe(true);
    expect(health.tunnel).toBe(true);
    expect(health.tunnel_url).toContain("https://healthcheck-test.trycloudflare.com");
  });
});

// ---------------------------------------------------------------------------
// Tests: services.health — no tunnel running
// ---------------------------------------------------------------------------

describe("services.health — no tunnel running", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns tunnel false when no tunnel is running", async () => {
    const res = await trpcQuery(server.url, "services.health", undefined, {
      headers: { Cookie: authCookie(DEFAULT_TOKEN) },
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{
      webserver: boolean;
      tunnel: boolean;
      tunnel_url: string | null;
    }>(res);
    expect(data.webserver).toBe(true);
    expect(data.tunnel).toBe(false);
    expect(data.tunnel_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: tunnel crash — server detects cloudflared death
// ---------------------------------------------------------------------------

describe("tunnel crash — health reflects down state after cloudflared dies", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    const binDir = join(tmpHome, "bin");
    mkdirSync(binDir, { recursive: true });
    createFakeCloudflaredCrash(binDir, "crash-test", 1);

    server = await startServer({
      tmpHome,
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        SHELL: "/bin/sh",
      },
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("starts tunnel, cloudflared crashes, status and health reflect the crash", async () => {
    // 1. Start tunnel — should get URL before crash
    const startRes = await trpcMutate(
      server.url,
      "tunnel.start",
      {},
      { headers: { Cookie: authCookie(DEFAULT_TOKEN) } },
    );
    expect(startRes.status).toBe(200);
    const startData = await trpcData<{ ok: boolean; url: string | null }>(startRes);
    expect(startData.ok).toBe(true);
    expect(startData.url).toContain("https://crash-test.trycloudflare.com");

    // 2. Verify tunnel is initially running
    const statusRes = await trpcQuery(server.url, "tunnel.status", undefined, {
      headers: { Cookie: authCookie(DEFAULT_TOKEN) },
    });
    const status = await trpcData<{ running: boolean; url: string | null }>(statusRes);
    expect(status.running).toBe(true);

    // 3. Wait for cloudflared to crash (exits after 1s) and server to detect it
    await waitFor(async () => {
      const res = await trpcQuery(server.url, "tunnel.status", undefined, {
        headers: { Cookie: authCookie(DEFAULT_TOKEN) },
      });
      const s = await trpcData<{ running: boolean; url: string | null }>(res);
      return !s.running;
    });

    // 4. Verify tunnel.status shows not running
    const afterCrashStatus = await trpcQuery(server.url, "tunnel.status", undefined, {
      headers: { Cookie: authCookie(DEFAULT_TOKEN) },
    });
    const crashed = await trpcData<{ running: boolean; url: string | null }>(afterCrashStatus);
    expect(crashed.running).toBe(false);
    expect(crashed.url).toBeNull();

    // 5. Verify services.health reflects tunnel is down
    const healthRes = await trpcQuery(server.url, "services.health", undefined, {
      headers: { Cookie: authCookie(DEFAULT_TOKEN) },
    });
    const health = await trpcData<{
      webserver: boolean;
      tunnel: boolean;
      tunnel_url: string | null;
    }>(healthRes);
    expect(health.webserver).toBe(true);
    expect(health.tunnel).toBe(false);
    expect(health.tunnel_url).toBeNull();
  });
});
