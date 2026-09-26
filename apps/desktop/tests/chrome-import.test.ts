/**
 * Chrome profile discovery and cookie decryption against a real on-disk
 * Chrome layout: a temp user-data dir with a `Local State` file and a
 * SQLite `Cookies` DB (Chrome's schema) whose values are encrypted the way
 * Chrome encrypts them on macOS. No mocks. The Keychain lookup is the only
 * thing replaced, by passing a known password to `readChromeCookies`,
 * because the real call needs an interactive macOS dialog.
 *
 * The Electron half (`cookies.set` into a session partition) needs the
 * Electron runtime and is not covered here.
 */

import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import {
  chromeTimeToUnixSeconds,
  readChromeCookies,
} from "../src/browser/chrome-import/chrome-cookies.ts";
import { listChromeProfiles } from "../src/browser/chrome-import/chrome-profiles.ts";

const PASSWORD = "test-safe-storage-password";
const CHROME_EPOCH_OFFSET_S = 11644473600;

function encrypt(value: string, host: string, withHostHash: boolean, password = PASSWORD) {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  const plain = withHostHash
    ? Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value, "latin1")])
    : Buffer.from(value, "latin1");
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

function chromeTime(unixSeconds: number): bigint {
  return BigInt(unixSeconds + CHROME_EPOCH_OFFSET_S) * 1_000_000n;
}

interface Row {
  host: string;
  name: string;
  value?: string;
  encrypted?: Buffer;
  path?: string;
  expires?: bigint;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: number;
  topFrameSiteKey?: string;
}

/** Create a cookie DB with Chrome's `meta` + `cookies` tables. */
function writeCookieDb(path: string, version: number, rows: Row[]) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL,
      name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
      last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL,
      priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL,
      source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,
      has_cross_site_ancestor INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(String(version));
  const insert = db.prepare(
    `INSERT INTO cookies VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, 2, 443, 0, 0, 0)`,
  );
  for (const r of rows) {
    const expires = r.expires ?? 0n;
    insert.run(
      r.host,
      r.topFrameSiteKey ?? "",
      r.name,
      r.value ?? "",
      r.encrypted ?? Buffer.alloc(0),
      r.path ?? "/",
      expires,
      r.secure ? 1 : 0,
      r.httpOnly ? 1 : 0,
      expires > 0n ? 1 : 0,
      expires > 0n ? 1 : 0,
      r.sameSite ?? -1,
    );
  }
  db.close();
}

describe("Chrome cookie import", () => {
  let userDataDir: string;
  const inOneYear = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

  before(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "band-chrome-import-test-"));
    writeFileSync(
      join(userDataDir, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: "Personal" },
            "Profile 1": { name: "Work" },
            "Profile 2": { name: "Never opened" },
            "../escape": { name: "Evil" },
          },
        },
      }),
    );
    // Current layout: Network/Cookies, DB version 24 (host-hash prefix).
    mkdirSync(join(userDataDir, "Default", "Network"), { recursive: true });
    writeCookieDb(join(userDataDir, "Default", "Network", "Cookies"), 24, [
      {
        host: ".example.com",
        name: "session",
        encrypted: encrypt("s3cr3t", ".example.com", true),
        path: "/app",
        expires: chromeTime(inOneYear),
        secure: true,
        httpOnly: true,
        sameSite: 1,
      },
      {
        host: "www.example.org",
        name: "pref",
        encrypted: encrypt("dark", "www.example.org", true),
        sameSite: 0,
        secure: true,
      },
      { host: "plain.example.net", name: "legacy", value: "unencrypted" },
      { host: ".google.com", name: "SID", encrypted: encrypt("g", ".google.com", true) },
      {
        host: ".embed.example",
        name: "chips",
        encrypted: encrypt("p", ".embed.example", true),
        topFrameSiteKey: "https://top.example",
      },
      {
        host: ".old.example",
        name: "expired",
        encrypted: encrypt("x", ".old.example", true),
        expires: chromeTime(1_000_000_000),
      },
      {
        host: ".other.example",
        name: "wrongkey",
        encrypted: encrypt("y", ".other.example", true, "some-other-password"),
      },
    ]);
    // Legacy layout: Cookies at the profile root, DB version 23 (no prefix).
    mkdirSync(join(userDataDir, "Profile 1"), { recursive: true });
    writeCookieDb(join(userDataDir, "Profile 1", "Cookies"), 23, [
      { host: ".work.example", name: "token", encrypted: encrypt("abc", ".work.example", false) },
    ]);
    // "Profile 2" has no cookie DB at all.
    mkdirSync(join(userDataDir, "Profile 2"), { recursive: true });
  });

  after(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("lists only profiles with a cookie DB and a safe directory name", () => {
    assert.deepEqual(listChromeProfiles(userDataDir), [
      { directory: "Default", name: "Personal" },
      { directory: "Profile 1", name: "Work" },
    ]);
  });

  it("returns no profiles when Chrome was never installed", () => {
    assert.deepEqual(listChromeProfiles(join(userDataDir, "missing")), []);
  });

  it("decrypts cookies, strips the host hash and maps them for Electron", async () => {
    const result = await readChromeCookies(
      join(userDataDir, "Default", "Network", "Cookies"),
      async () => PASSWORD,
    );

    assert.equal(result.total, 7);
    assert.equal(result.skippedGoogle, 1);
    assert.equal(result.skippedPartitioned, 1);
    assert.equal(result.skippedExpired, 1);
    assert.equal(result.undecryptable, 1);
    assert.deepEqual(result.cookies, [
      {
        url: "https://example.com/",
        name: "session",
        value: "s3cr3t",
        domain: ".example.com",
        path: "/app",
        secure: true,
        httpOnly: true,
        expirationDate: inOneYear,
        sameSite: "lax",
      },
      {
        // Host-only cookie: no `domain`, so Electron keeps it host-only.
        url: "https://www.example.org/",
        name: "pref",
        value: "dark",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "no_restriction",
      },
      {
        url: "http://plain.example.net/",
        name: "legacy",
        value: "unencrypted",
        path: "/",
        secure: false,
        httpOnly: false,
        sameSite: "unspecified",
      },
    ]);
  });

  it("reads pre-v24 DBs without stripping a host hash", async () => {
    const result = await readChromeCookies(
      join(userDataDir, "Profile 1", "Cookies"),
      async () => PASSWORD,
    );
    assert.equal(result.cookies.length, 1);
    assert.equal(result.cookies[0]?.value, "abc");
    assert.equal(result.cookies[0]?.domain, ".work.example");
  });

  it("asks for the Keychain password once, and only when a value is encrypted", async () => {
    let calls = 0;
    await readChromeCookies(join(userDataDir, "Default", "Network", "Cookies"), async () => {
      calls++;
      return PASSWORD;
    });
    assert.equal(calls, 1);

    const plainDir = mkdtempSync(join(tmpdir(), "band-chrome-plain-"));
    try {
      writeCookieDb(join(plainDir, "Cookies"), 24, [{ host: "a.example", name: "n", value: "v" }]);
      let plainCalls = 0;
      const result = await readChromeCookies(join(plainDir, "Cookies"), async () => {
        plainCalls++;
        return PASSWORD;
      });
      assert.equal(plainCalls, 0);
      assert.equal(result.cookies[0]?.value, "v");
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it("propagates a denied Keychain prompt", async () => {
    await assert.rejects(
      readChromeCookies(join(userDataDir, "Default", "Network", "Cookies"), async () => {
        throw new Error("denied");
      }),
      /denied/,
    );
  });

  it("converts Chrome timestamps to Unix seconds", () => {
    assert.equal(chromeTimeToUnixSeconds(0n), 0);
    assert.equal(chromeTimeToUnixSeconds(chromeTime(1_700_000_000)), 1_700_000_000);
  });
});
