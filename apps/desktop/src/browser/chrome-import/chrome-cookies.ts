/**
 * Read and decrypt a Chrome profile's cookie DB on macOS.
 *
 * Chrome encrypts cookie values with AES-128-CBC. The key is derived with
 * PBKDF2-SHA1 (salt `saltysalt`, 1003 iterations, 16 bytes) from the
 * "Chrome Safe Storage" password in the login Keychain, and the IV is 16
 * spaces. Encrypted values start with the `v10` version tag. Since cookie DB
 * version 24 (Chrome 130), the plaintext starts with a 32-byte SHA-256 of the
 * cookie's `host_key`. It is checked and stripped here, which also rejects a
 * wrong key whose output happens to have valid padding.
 *
 * Chrome holds its DB open and writes through a WAL, so the DB and its WAL
 * are copied into a private temp dir (mode 0700) and read from there. The
 * copy is deleted before this module returns.
 *
 * Cookie values are secrets: nothing here logs them.
 */

import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CookieSameSite = "unspecified" | "no_restriction" | "lax" | "strict";

/** A decrypted Chrome cookie, shaped for Electron's `session.cookies.set`. */
export interface ChromeCookie {
  url: string;
  name: string;
  value: string;
  /** Set for domain cookies (`.example.com`); omitted for host-only cookies. */
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds. Omitted for session cookies. */
  expirationDate?: number;
  sameSite: CookieSameSite;
}

export interface ChromeCookieReadResult {
  cookies: ChromeCookie[];
  /** Rows in the source DB. */
  total: number;
  /** google.com cookies, which Google binds to the device that created them. */
  skippedGoogle: number;
  /** CHIPS (partitioned) cookies, which `session.cookies.set` can't express. */
  skippedPartitioned: number;
  skippedExpired: number;
  /** Rows whose value could not be decrypted. */
  undecryptable: number;
}

const PBKDF2_SALT = "saltysalt";
const PBKDF2_ITERATIONS = 1003;
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, " ");
const HOST_HASH_LENGTH = 32;
/** First cookie DB version that prefixes values with SHA-256(host). */
const HOST_HASH_DB_VERSION = 24;
/** Seconds between 1601-01-01 (Chrome's epoch) and 1970-01-01. */
const CHROME_EPOCH_OFFSET_S = 11644473600n;

/** Derive the AES key from the Keychain's "Chrome Safe Storage" password. */
export function deriveChromeKey(safeStoragePassword: string): Buffer {
  return pbkdf2Sync(safeStoragePassword, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LENGTH, "sha1");
}

/**
 * Decrypt one `encrypted_value`. `hostKey` is the row's `host_key` when the
 * DB is version 24+ and the plaintext carries its hash, otherwise `null`.
 * Returns `null` for an unknown version tag, a wrong key, or a host hash
 * that doesn't match.
 */
export function decryptChromeValue(
  encrypted: Uint8Array,
  key: Buffer,
  hostKey: string | null,
): Buffer | null {
  const buf = Buffer.from(encrypted);
  if (buf.length <= 3 || buf.subarray(0, 3).toString("latin1") !== "v10") return null;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }
  if (hostKey === null) return plain;
  if (plain.length < HOST_HASH_LENGTH) return null;
  const expected = createHash("sha256").update(hostKey).digest();
  if (!plain.subarray(0, HOST_HASH_LENGTH).equals(expected)) return null;
  return plain.subarray(HOST_HASH_LENGTH);
}

/** Chrome timestamps are microseconds since 1601-01-01. 0 means "no expiry". */
export function chromeTimeToUnixSeconds(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const micros = typeof value === "bigint" ? value : BigInt(Math.round(value));
  if (micros <= 0n) return 0;
  const seconds = micros / 1_000_000n - CHROME_EPOCH_OFFSET_S;
  return seconds > 0n ? Number(seconds) : 0;
}

/** Chrome's `samesite` column: -1 unspecified, 0 None, 1 Lax, 2 Strict. */
export function chromeSameSite(value: bigint | number | null | undefined): CookieSameSite {
  switch (Number(value ?? -1)) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

/**
 * Google binds its session cookies to the device that minted them and may
 * sign the user out everywhere when they show up elsewhere, so they are
 * never copied. The user signs in to Google inside Band instead.
 */
export function isGoogleHost(host: string): boolean {
  return /(^|\.)google\.(com|[a-z]{2,3})(\.[a-z]{2})?$/.test(host);
}

interface CookieRow {
  host_key: string;
  name: string;
  value: string | Uint8Array | null;
  encrypted_value: Uint8Array | null;
  path: string;
  expires_utc: bigint;
  is_secure: bigint;
  is_httponly: bigint;
  samesite: bigint;
  top_frame_site_key?: string | null;
}

/**
 * Copy a live cookie DB (plus its WAL / rollback journal) into a fresh
 * private temp dir and return the copy's path and a cleanup function.
 */
function snapshotCookieDb(cookiesPath: string): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "band-chrome-cookies-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  try {
    const dbPath = join(dir, "Cookies");
    copyFileSync(cookiesPath, dbPath);
    for (const suffix of ["-wal", "-journal"]) {
      if (existsSync(cookiesPath + suffix)) copyFileSync(cookiesPath + suffix, dbPath + suffix);
    }
    return { dbPath, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Read every cookie from a Chrome cookie DB and decrypt it.
 *
 * `getPassword` is only called when at least one row is encrypted, so the
 * macOS Keychain prompt doesn't appear for a profile with no cookies.
 */
export async function readChromeCookies(
  cookiesPath: string,
  getPassword: () => Promise<string>,
  now: number = Date.now(),
): Promise<ChromeCookieReadResult> {
  // Loaded here, not at module top: this module is imported at main-process
  // boot, and a failure to load `node:sqlite` must only fail the import.
  const { DatabaseSync } = await import("node:sqlite");
  const { dbPath, cleanup } = snapshotCookieDb(cookiesPath);
  let rows: CookieRow[];
  let dbVersion = 0;
  try {
    // Read-write on purpose: the copy is private, and SQLite needs to write
    // a `-shm` file to open a WAL-mode DB.
    const db = new DatabaseSync(dbPath, { readBigInts: true });
    try {
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
        | { value: string }
        | undefined;
      dbVersion = Number(meta?.value ?? 0);
      const columns = new Set(
        (db.prepare("PRAGMA table_info(cookies)").all() as { name: string }[]).map((c) => c.name),
      );
      const partitionColumn = columns.has("top_frame_site_key") ? ", top_frame_site_key" : "";
      rows = db
        .prepare(
          `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure,
                  is_httponly, samesite${partitionColumn}
             FROM cookies ORDER BY rowid`,
        )
        .all() as unknown as CookieRow[];
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }

  const result: ChromeCookieReadResult = {
    cookies: [],
    total: rows.length,
    skippedGoogle: 0,
    skippedPartitioned: 0,
    skippedExpired: 0,
    undecryptable: 0,
  };
  const nowSeconds = Math.floor(now / 1000);
  const hasHostHash = dbVersion >= HOST_HASH_DB_VERSION;
  let key: Buffer | null = null;

  for (const row of rows) {
    const host = row.host_key.startsWith(".") ? row.host_key.slice(1) : row.host_key;
    if (!host) {
      result.undecryptable++;
      continue;
    }
    if (isGoogleHost(host)) {
      result.skippedGoogle++;
      continue;
    }
    if (row.top_frame_site_key) {
      result.skippedPartitioned++;
      continue;
    }
    const expires = chromeTimeToUnixSeconds(row.expires_utc);
    if (expires > 0 && expires <= nowSeconds) {
      result.skippedExpired++;
      continue;
    }

    let value: string;
    if (row.encrypted_value && row.encrypted_value.length > 0) {
      if (!key) key = deriveChromeKey(await getPassword());
      const plain = decryptChromeValue(row.encrypted_value, key, hasHostHash ? row.host_key : null);
      if (!plain) {
        result.undecryptable++;
        continue;
      }
      // Cookie values are bytes, not UTF-8; latin1 keeps every byte as-is.
      value = plain.toString("latin1");
    } else if (row.value instanceof Uint8Array) {
      value = Buffer.from(row.value).toString("latin1");
    } else {
      value = row.value ?? "";
    }

    const secure = row.is_secure === 1n;
    const hostOnly = !row.host_key.startsWith(".");
    result.cookies.push({
      url: `${secure ? "https" : "http"}://${host}/`,
      name: row.name,
      value,
      ...(hostOnly ? {} : { domain: row.host_key }),
      path: row.path || "/",
      secure,
      httpOnly: row.is_httponly === 1n,
      ...(expires > 0 ? { expirationDate: expires } : {}),
      sameSite: chromeSameSite(row.samesite),
    });
  }

  return result;
}
