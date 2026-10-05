/**
 * Encryption at rest for `vault_items` (plan step 4.1).
 *
 * AES-256-GCM with a random 12-byte nonce per encryption. The item id is the
 * additional authenticated data, so a blob copied onto another row fails to
 * decrypt. A blob is `v1:` plus base64 of `nonce || ciphertext || tag`.
 *
 * The key is `BAND_VAULT_KEY` (32 bytes as base64 or 64 hex characters) or,
 * with that unset, a key file `<BAND_HOME>/vault.key` (mode 0600) generated on
 * first use. Neither the key nor a secret reaches a log line or an error.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VaultInputError } from "../../errors";
import { bandHome } from "../../infra/db/queries/settings";

const VERSION = "v1:";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function vaultKeyFile(): string {
  return join(bandHome(), "vault.key");
}

/** The key source in use: the environment wins over the key file. */
export function keySource(): "env" | "file" {
  return process.env.BAND_VAULT_KEY?.trim() ? "env" : "file";
}

export function parseKey(raw: string): Buffer {
  const text = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(text)
    ? Buffer.from(text, "hex")
    : Buffer.from(text, "base64");
  if (key.length !== KEY_BYTES) {
    throw new VaultInputError("The vault key must be 32 bytes, as base64 or 64 hex characters.");
  }
  return key;
}

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Loads the key, creating the key file the first time. */
export function loadKey(): Buffer {
  const fromEnv = process.env.BAND_VAULT_KEY?.trim();
  if (fromEnv) return parseKey(fromEnv);
  const file = vaultKeyFile();
  if (existsSync(file)) return parseKey(readFileSync(file, "utf8"));
  const key = generateKey();
  writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return key;
}

/**
 * Writes the new key to a temp file beside the key file. `commit` renames it into place, which
 * callers do only after the re-encrypted rows are committed. `discard` removes the temp file.
 */
export function stageKeyFile(key: Buffer): { commit: () => void; discard: () => void } {
  const file = vaultKeyFile();
  const temp = `${file}.${process.pid}.next`;
  writeFileSync(temp, `${key.toString("base64")}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  return { commit: () => renameSync(temp, file), discard: () => rmSync(temp, { force: true }) };
}

export function encrypt(key: Buffer, aad: string, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return VERSION + Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

export function decrypt(key: Buffer, aad: string, blob: string): string {
  if (!blob.startsWith(VERSION)) throw new VaultInputError("Unrecognised credential format.");
  const raw = Buffer.from(blob.slice(VERSION.length), "base64");
  if (raw.length < NONCE_BYTES + TAG_BYTES) throw new VaultInputError("Credential is corrupt.");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE_BYTES));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new VaultInputError("The vault key cannot decrypt this credential.");
  }
}
