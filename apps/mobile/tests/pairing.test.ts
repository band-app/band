import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allowsPlainHttp, parseHubUrl, parsePairLink, parseSignInUrl } from "../src/lib/pairing.ts";

/**
 * The sign-in link exactly as Settings > Devices builds it for the QR code
 * (`apps/web/src/dashboard/components/settings/DevicesSettings.tsx`):
 * `${hubPublicUrl().replace(/\/+$/, "")}/?token=${encodeURIComponent(result.token)}`.
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
      error: "The link has no token",
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
