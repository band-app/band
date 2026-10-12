/**
 * Where the desktop app keeps secrets it must not leave in plain text: the remote hub's token.
 * In the app this is Electron's `safeStorage`, which encrypts with a key held by the OS (the
 * macOS Keychain entry "Band Safe Storage"), so another process reading the file under `~/.band`
 * gets ciphertext it cannot open. The interface keeps `hub-choice.ts` free of an Electron import,
 * so its tests run under plain Node. `electron-secret-store.ts` is the Electron half.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface SecretStore {
  /** False when the OS gives no key store (a Linux box with no keyring), so callers fall back. */
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

let store: SecretStore | null = null;

export function setSecretStore(next: SecretStore | null): void {
  store = next;
}

/** The store in use, or null when none is installed or the OS cannot provide one. */
export function activeSecretStore(): SecretStore | null {
  return store?.available() ? store : null;
}

/**
 * A store with a fixed key, for tests (`BAND_DESKTOP_SECRET_STORE=test`). The e2e harness has no
 * Keychain to unlock, so this stands in for `safeStorage` and still writes ciphertext.
 */
export function createTestSecretStore(): SecretStore {
  const key = createHash("sha256").update("band-desktop-test-secret-store").digest();
  return {
    available: () => true,
    encrypt(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt(data) {
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
