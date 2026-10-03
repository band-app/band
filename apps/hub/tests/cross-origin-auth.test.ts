// Integration tests for cross-origin auth (plan step 1A.3): Bearer tokens on
// HTTP, the `band-token.<token>` subprotocol on WebSockets, and the CORS
// allowlist. Real production server on a random port with auth on.

import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { seedSettings } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";

const TOKEN = "cross-origin-test-token";
const ALLOWED_ORIGIN = "http://ui.allowed.test";
const SETTINGS_ORIGIN = "http://ui.settings.test";
const EVIL_ORIGIN = "http://evil.test";

let home: string;
let server: ServerHandle;

beforeAll(async () => {
  home = createTmpHome("band-cross-origin-auth-");
  seedSettings(home, { tokenSecret: TOKEN, corsAllowedOrigins: [SETTINGS_ORIGIN] });
  server = await startServer({ tmpHome: home, env: { BAND_CORS_ORIGINS: ALLOWED_ORIGIN } });
}, 60_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const bearer = { Authorization: `Bearer ${TOKEN}` };

describe("HTTP auth", () => {
  it("returns 401 for a missing or wrong token on every kind of route", async () => {
    for (const path of [
      "/api/health",
      "/trpc/projects.list",
      "/api/chats/x/events",
      "/api/uploads/x.png",
      "/",
    ]) {
      expect((await fetch(`${server.url}${path}`)).status).toBe(401);
      const wrong = await fetch(`${server.url}${path}`, {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(wrong.status).toBe(401);
    }
  });

  it("accepts the token as a Bearer header", async () => {
    const health = await fetch(`${server.url}/api/health`, { headers: bearer });
    expect(health.status).toBe(200);
    const trpc = await fetch(`${server.url}/trpc/projects.list`, { headers: bearer });
    expect(trpc.status).toBe(200);
  });

  it("accepts the token in the query for asset GETs and rejects a wrong one", async () => {
    const ok = await fetch(`${server.url}/api/uploads/missing.png?token=${TOKEN}`);
    expect(ok.status).toBe(404);
    const bad = await fetch(`${server.url}/api/uploads/missing.png?token=wrong`);
    expect(bad.status).toBe(401);
  });

  it("ignores the cookie from an opaque origin but accepts its Bearer token", async () => {
    const withCookie = await fetch(`${server.url}/trpc/projects.list`, {
      headers: { Cookie: `band_token=${TOKEN}`, Origin: "null" },
    });
    expect(withCookie.status).toBe(401);
    const withBearer = await fetch(`${server.url}/trpc/projects.list`, {
      headers: { ...bearer, Origin: "null" },
    });
    expect(withBearer.status).toBe(200);
  });

  it("returns 401 for an unauthenticated POST", async () => {
    const res = await fetch(`${server.url}/api/chats/x/submit`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("keeps the ?token= link login and cookie auth", async () => {
    const login = await fetch(`${server.url}/?token=${TOKEN}`);
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain(`band_token=${TOKEN}`);
    const cookie = await fetch(`${server.url}/trpc/projects.list`, {
      headers: { Cookie: `band_token=${TOKEN}` },
    });
    expect(cookie.status).toBe(200);
  });
});

describe("CORS allowlist", () => {
  it("answers a preflight from an allowed origin without credentials", async () => {
    for (const origin of [ALLOWED_ORIGIN, SETTINGS_ORIGIN, "app://band", "null"]) {
      const res = await fetch(`${server.url}/trpc/projects.list`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-headers")).toBe("authorization");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("serves an authenticated request from an allowed origin", async () => {
    const res = await fetch(`${server.url}/trpc/projects.list`, {
      headers: { ...bearer, Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("blocks a preflight and a request from an origin outside the allowlist", async () => {
    const preflight = await fetch(`${server.url}/trpc/projects.list`, {
      method: "OPTIONS",
      headers: { Origin: EVIL_ORIGIN, "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    // Even with a valid token and cookie, no data comes back.
    const res = await fetch(`${server.url}/trpc/projects.list`, {
      headers: { ...bearer, Cookie: `band_token=${TOKEN}`, Origin: EVIL_ORIGIN },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.text()).toBe("Origin not allowed");
  });

  it("treats the server's own origin as same-origin", async () => {
    const res = await fetch(`${server.url}/trpc/projects.list`, {
      headers: { Cookie: `band_token=${TOKEN}`, Origin: server.url },
    });
    expect(res.status).toBe(200);
  });
});

type Outcome = "open" | "closed";

function connect(
  path: string,
  opts: { protocols?: string[]; headers?: Record<string, string> } = {},
): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${server.url.replace("http", "ws")}${path}`, opts.protocols, {
      headers: opts.headers,
    });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("error", () => resolve("closed"));
    ws.on("unexpected-response", () => resolve("closed"));
  });
}

const WS_PATHS = [
  "/trpc",
  "/terminal?workspaceId=none&terminalId=none",
  "/lsp?workspaceId=none&lang=ts",
  "/cdp",
];

describe("WebSocket auth", () => {
  for (const path of WS_PATHS) {
    const name = path.split("?")[0];

    it(`${name} rejects a missing or wrong token`, async () => {
      expect(await connect(path)).toBe("closed");
      expect(await connect(path, { protocols: ["band", "band-token.wrong"] })).toBe("closed");
      expect(await connect(path, { headers: { Cookie: "band_token=wrong" } })).toBe("closed");
    });

    it(`${name} does not take the token from the query string`, async () => {
      const sep = path.includes("?") ? "&" : "?";
      expect(await connect(`${path}${sep}token=${TOKEN}`)).toBe("closed");
    });

    it(`${name} accepts the subprotocol, the cookie and a Bearer header`, async () => {
      expect(await connect(path, { protocols: ["band", `band-token.${TOKEN}`] })).toBe("open");
      expect(await connect(path, { headers: { Cookie: `band_token=${TOKEN}` } })).toBe("open");
      expect(await connect(path, { headers: bearer })).toBe("open");
    });

    it(`${name} refuses a browser origin outside the allowlist`, async () => {
      const protocols = ["band", `band-token.${TOKEN}`];
      expect(await connect(path, { protocols, headers: { Origin: EVIL_ORIGIN } })).toBe("closed");
      expect(await connect(path, { protocols, headers: { Origin: ALLOWED_ORIGIN } })).toBe("open");
    });
  }

  it("does not echo the token back in the selected subprotocol", async () => {
    const selected = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${server.url.replace("http", "ws")}/trpc`, [
        "band",
        `band-token.${TOKEN}`,
      ]);
      ws.on("open", () => {
        resolve(ws.protocol);
        ws.close();
      });
      ws.on("error", () => resolve("error"));
    });
    expect(selected).toBe("band");
  });
});
