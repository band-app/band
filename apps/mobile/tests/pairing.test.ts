import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import {
  allowsPlainHttp,
  exchangePairingCode,
  PAIRING_REFUSED,
  parseHubUrl,
  parsePairLink,
  parseSignInUrl,
} from "../src/lib/pairing.ts";

/**
 * The older sign-in link that carries the token itself: `<address>/?token=<token>`. Settings >
 * Devices no longer builds it, but links made before pairing codes must keep working.
 */
function devicesSignInUrl(hubPublicUrl: string, token: string): string {
  const base = hubPublicUrl.replace(/\/+$/, "");
  return `${base}/?token=${encodeURIComponent(token)}`;
}

/** The deep link a test or a person opens, read the way expo-router hands the route its params. */
function deepLinkParams(hubUrl: string, token: string) {
  const link = new URL(
    `band://pair?url=${encodeURIComponent(hubUrl)}&token=${encodeURIComponent(token)}`,
  );
  return { url: link.searchParams.get("url"), token: link.searchParams.get("token") };
}

const TOKEN = "bdt_3q2-Zx_9kLm0PqRsTuVwXyZaBcDeFgHiJkLmNoPq";

describe("S5: the Devices QR code and the deep link pair the same hub", () => {
  for (const hub of [
    "https://hub.example.com",
    "https://hub.example.com/",
    "https://band-tunnel.trycloudflare.com",
    "http://192.168.1.20:3456",
    "http://127.0.0.1:3456",
  ]) {
    it(`gives one URL and token for ${hub}`, () => {
      const fromQr = parseSignInUrl(devicesSignInUrl(hub, TOKEN));
      const fromLink = parsePairLink(deepLinkParams(hub, TOKEN));
      assert.deepEqual(fromQr, fromLink);
      assert.deepEqual(fromQr, { ok: true, value: { url: new URL(hub).origin, token: TOKEN } });
    });
  }

  it("keeps a token with characters the QR code percent-encodes", () => {
    const token = "bdt_a+b/c=d";
    const fromQr = parseSignInUrl(devicesSignInUrl("https://hub.example.com", token));
    assert.deepEqual(fromQr, { ok: true, value: { url: "https://hub.example.com", token } });
  });
});

describe("pairing input errors", () => {
  it("refuses a sign-in link without a token", () => {
    assert.deepEqual(parseSignInUrl("https://hub.example.com/"), {
      ok: false,
      error: "The link has no pairing code or token",
    });
  });

  it("refuses a QR code that is not a URL", () => {
    assert.deepEqual(parseSignInUrl("hello"), {
      ok: false,
      error: "This QR code is not a Band sign-in link",
    });
  });

  it("refuses a deep link without a hub URL", () => {
    assert.deepEqual(parsePairLink({ token: TOKEN }), {
      ok: false,
      error: "The link has no hub URL",
    });
  });

  it("refuses plain http to a hub outside the local network", () => {
    const result = parseSignInUrl(devicesSignInUrl("http://hub.example.com", TOKEN));
    assert.deepEqual(result, {
      ok: false,
      error: "A hub outside your local network needs an https:// URL",
    });
  });

  it("refuses other schemes", () => {
    assert.deepEqual(parseHubUrl("ftp://hub.example.com"), {
      ok: false,
      error: "The hub URL must start with https:// or http://",
    });
  });
});

describe("plain http only on local addresses", () => {
  for (const host of [
    "localhost",
    "127.0.0.1",
    "[::1]",
    "10.0.0.5",
    "172.16.4.1",
    "172.31.255.1",
    "192.168.1.20",
    "169.254.3.3",
    "100.101.102.103",
    "[fd7a:115c:a1e0::1]",
    "macbook.local",
  ]) {
    it(`allows ${host}`, () => assert.equal(allowsPlainHttp(host), true));
  }
  for (const host of ["hub.example.com", "8.8.8.8", "172.32.0.1", "192.169.0.1", "100.128.0.1"]) {
    it(`refuses ${host}`, () => assert.equal(allowsPlainHttp(host), false));
  }
});

const CODE = "bdp_3q2-Zx_9kLm0PqRsTuVwXyZaBcDeFgHiJkLmNoPq";

describe("S5: a pairing code in the web link and the deep link", () => {
  const pairingLink = (hub: string, code: string) =>
    `${hub.replace(/\/+$/, "")}/?pair=${encodeURIComponent(code)}`;

  for (const hub of ["https://hub.example.com/", "http://192.168.1.20:3456"]) {
    it(`gives one URL and code for ${hub}`, () => {
      const link = new URL(
        `band://pair?url=${encodeURIComponent(hub)}&code=${encodeURIComponent(CODE)}`,
      );
      const fromQr = parseSignInUrl(pairingLink(hub, CODE));
      const fromLink = parsePairLink({
        url: link.searchParams.get("url"),
        code: link.searchParams.get("code"),
      });
      assert.deepEqual(fromQr, fromLink);
      assert.deepEqual(fromQr, { ok: true, value: { url: new URL(hub).origin, code: CODE } });
    });
  }

  it("prefers the code when a link carries both", () => {
    assert.deepEqual(parsePairLink({ url: "https://hub.example.com", code: CODE, token: TOKEN }), {
      ok: true,
      value: { url: "https://hub.example.com", code: CODE },
    });
  });
});

describe("S5: exchanging a pairing code", () => {
  async function withHub<T>(
    handler: (body: { code?: string }) => { status: number; json?: unknown },
    run: (url: string, calls: string[]) => Promise<T>,
  ): Promise<T> {
    const calls: string[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        calls.push(`${req.method} ${req.url}`);
        const out = handler(JSON.parse(raw || "{}"));
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.json ?? {}));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      return await run(`http://127.0.0.1:${port}`, calls);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("trades the code for the device token", async () => {
    await withHub(
      (body) =>
        body.code === CODE
          ? { status: 200, json: { token: TOKEN, deviceId: "d1", label: "iPhone", admin: false } }
          : { status: 401 },
      async (url, calls) => {
        const result = await exchangePairingCode({ url, code: CODE });
        assert.deepEqual(result, { ok: true, value: { url, token: TOKEN } });
        assert.deepEqual(calls, ["POST /api/pair/exchange"]);
      },
    );
  });

  it("says the link was used or has expired when the hub refuses", async () => {
    await withHub(
      () => ({ status: 401, json: { error: "refused" } }),
      async (url) => {
        assert.deepEqual(await exchangePairingCode({ url, code: CODE }), {
          ok: false,
          error: PAIRING_REFUSED,
        });
      },
    );
  });

  it("passes an old token link through without calling the hub", async () => {
    await withHub(
      () => ({ status: 500 }),
      async (url, calls) => {
        assert.deepEqual(await exchangePairingCode({ url, token: TOKEN }), {
          ok: true,
          value: { url, token: TOKEN },
        });
        assert.deepEqual(calls, []);
      },
    );
  });

  it("reports a hub that cannot be reached", async () => {
    const result = await exchangePairingCode({ url: "http://127.0.0.1:1", code: CODE });
    assert.equal(result.ok, false);
  });
});
