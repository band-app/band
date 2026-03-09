import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthMiddleware } from "../auth.ts";

const TEST_SECRET = "test-secret-key-for-auth";
const EXPECTED_TOKEN = createHmac("sha256", TEST_SECRET).update("band-access").digest("hex");

function startServer(secret: string | undefined) {
  const { handleAuth } = createAuthMiddleware(secret);

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (handleAuth(req, res)) return;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// -------------------------------------------------------------------------
// Auth enabled (with secret)
// -------------------------------------------------------------------------

describe("auth middleware (with secret)", () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    server = await startServer(TEST_SECRET);
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns 401 for unauthenticated requests", async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Unauthorized");
  });

  it("returns 401 for requests with invalid token", async () => {
    const res = await fetch(`${server.url}/?token=invalid-token`);
    expect(res.status).toBe(401);
  });

  it("returns 401 for requests with invalid cookie", async () => {
    const res = await fetch(`${server.url}/`, {
      headers: { Cookie: "band_token=wrong-value" },
    });
    expect(res.status).toBe(401);
  });

  it("valid token query param sets cookie and passes through", async () => {
    const res = await fetch(`${server.url}/?token=${EXPECTED_TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain(`band_token=${EXPECTED_TOKEN}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=86400");
  });

  it("valid token on any path sets cookie and passes through", async () => {
    const res = await fetch(`${server.url}/chat?project=foo&token=${EXPECTED_TOKEN}&page=1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain(`band_token=${EXPECTED_TOKEN}`);
  });

  it("valid cookie allows request through", async () => {
    const res = await fetch(`${server.url}/`, {
      headers: { Cookie: `band_token=${EXPECTED_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("valid cookie works for any path", async () => {
    const res = await fetch(`${server.url}/some/deep/path`, {
      headers: { Cookie: `band_token=${EXPECTED_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });
});

// -------------------------------------------------------------------------
// /api/health endpoint
// -------------------------------------------------------------------------

describe("/api/health endpoint", () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    server = await startServer(TEST_SECRET);
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns 401 without auth", async () => {
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(401);
  });

  it("returns health JSON with valid token query param", async () => {
    const res = await fetch(`${server.url}/api/health?token=${EXPECTED_TOKEN}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.app).toBe("band-web-server");
    expect(typeof data.hostname).toBe("string");
    expect(data.hostname.length).toBeGreaterThan(0);
  });

  it("returns health JSON with valid cookie", async () => {
    const res = await fetch(`${server.url}/api/health`, {
      headers: { Cookie: `band_token=${EXPECTED_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.app).toBe("band-web-server");
  });

  it("returns 401 with invalid token", async () => {
    const res = await fetch(`${server.url}/api/health?token=bad-token`);
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------
// Auth disabled (no secret — dev mode)
// -------------------------------------------------------------------------

describe("auth middleware (without secret — dev mode)", () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    server = await startServer(undefined);
  });

  afterEach(async () => {
    await server.close();
  });

  it("allows all requests without auth", async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("allows requests to any path without auth", async () => {
    const res = await fetch(`${server.url}/some/path`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("passes unknown API paths through to app handler", async () => {
    const res = await fetch(`${server.url}/api/something`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });
});

// -------------------------------------------------------------------------
// createAuthMiddleware return value
// -------------------------------------------------------------------------

describe("createAuthMiddleware", () => {
  it("returns expected token when secret is provided", () => {
    const { expectedToken } = createAuthMiddleware(TEST_SECRET);
    expect(expectedToken).toBe(EXPECTED_TOKEN);
  });

  it("returns null token when no secret is provided", () => {
    const { expectedToken } = createAuthMiddleware(undefined);
    expect(expectedToken).toBeNull();
  });

  it("returns null token for empty string secret", () => {
    const { expectedToken } = createAuthMiddleware("");
    expect(expectedToken).toBeNull();
  });

  it("different secrets produce different tokens", () => {
    const { expectedToken: t1 } = createAuthMiddleware("secret-a");
    const { expectedToken: t2 } = createAuthMiddleware("secret-b");
    expect(t1).not.toBe(t2);
  });
});
