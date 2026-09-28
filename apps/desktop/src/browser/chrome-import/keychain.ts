/**
 * Read Chrome's cookie encryption password from the macOS login Keychain.
 *
 * `security find-generic-password` makes macOS show its own Keychain
 * dialog ("… wants to use your confidential information stored in
 * 'Chrome Safe Storage'"). The user can allow or deny it there; Band never
 * sees or stores their login password. Runs asynchronously so the app stays
 * responsive while the dialog is open.
 */

import { execFile } from "node:child_process";

const SERVICE = "Chrome Safe Storage";
const ACCOUNT = "Chrome";
/** Long enough for the user to read and answer the Keychain dialog. */
const TIMEOUT_MS = 120_000;

export class KeychainAccessError extends Error {
  constructor() {
    super("macOS did not give Band access to the Chrome Safe Storage key.");
    this.name = "KeychainAccessError";
  }
}

export function getChromeSafeStoragePassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", SERVICE, "-a", ACCOUNT],
      { timeout: TIMEOUT_MS, encoding: "utf-8" },
      (err, stdout) => {
        const password = stdout?.trim();
        if (err || !password) {
          // Don't forward stderr: it can echo Keychain item attributes.
          reject(new KeychainAccessError());
          return;
        }
        resolve(password);
      },
    );
  });
}
