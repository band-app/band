/**
 * Secrets an extension panel asks Band.app to remember for the viewer (the Desktop panel keeps
 * the Mac password of a worker this way). The values live in one file, `~/.band/desktop-panel-secrets.enc`,
 * encrypted with the OS key store (`secret-store.ts`, the macOS Keychain through Electron
 * `safeStorage`). A value is read back only after `confirm` passes, which in the app is Touch ID
 * or the account password. Every key is scoped by the extension id, so one extension never reads
 * another's secrets.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bandHome } from "./log.js";
import { activeSecretStore } from "./secret-store.js";

export const MAX_SECRET_KEY = 200;
export const MAX_SECRET_VALUE = 4096;
export const MAX_EXTENSION_ID = 200;
/** Most secrets one extension may keep. */
export const MAX_SECRETS_PER_EXTENSION = 200;

function file(): string {
  return join(bandHome(), "desktop-panel-secrets.enc");
}

type Table = Record<string, Record<string, string>>;

function load(): Table {
  const store = activeSecretStore();
  if (!store) return {};
  try {
    const parsed: unknown = JSON.parse(
      store.decrypt(Buffer.from(readFileSync(file(), "utf8"), "base64")),
    );
    return parsed && typeof parsed === "object" ? (parsed as Table) : {};
  } catch {
    return {};
  }
}

function save(table: Table): void {
  const store = activeSecretStore();
  if (!store) throw new Error("The OS key store is not available");
  mkdirSync(bandHome(), { recursive: true });
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, store.encrypt(JSON.stringify(table)).toString("base64"), { mode: 0o600 });
  renameSync(tmp, file());
}

function checkScope(extensionId: unknown, key: unknown): { ext: string; key: string } {
  if (
    typeof extensionId !== "string" ||
    !extensionId ||
    extensionId.length > MAX_EXTENSION_ID ||
    extensionId === "__proto__"
  ) {
    throw new Error("Invalid extension id");
  }
  if (typeof key !== "string" || !key || key.length > MAX_SECRET_KEY) {
    throw new Error("Invalid secret key");
  }
  return { ext: extensionId, key };
}

export interface PanelSecrets {
  available(): boolean;
  get(extensionId: unknown, key: unknown): Promise<string | null>;
  set(extensionId: unknown, key: unknown, value: unknown): void;
  delete(extensionId: unknown, key: unknown): void;
}

/**
 * `confirm` runs before a value is returned (Touch ID or the account password). A read of a key
 * that holds nothing returns null without prompting.
 */
export function createPanelSecrets(confirm: (reason: string) => Promise<void>): PanelSecrets {
  return {
    available: () => activeSecretStore() !== null,
    async get(extensionId, key) {
      const scope = checkScope(extensionId, key);
      const value = load()[scope.ext]?.[scope.key];
      if (typeof value !== "string") return null;
      await confirm("unlock the saved password for a Band extension");
      return value;
    },
    set(extensionId, key, value) {
      const scope = checkScope(extensionId, key);
      if (typeof value !== "string" || value.length > MAX_SECRET_VALUE) {
        throw new Error("Invalid secret value");
      }
      const table = load();
      const own = Object.hasOwn(table, scope.ext) ? table[scope.ext] : {};
      if (!(scope.key in own) && Object.keys(own).length >= MAX_SECRETS_PER_EXTENSION) {
        throw new Error("Too many secrets for this extension");
      }
      table[scope.ext] = { ...own, [scope.key]: value };
      save(table);
    },
    delete(extensionId, key) {
      const scope = checkScope(extensionId, key);
      const table = load();
      const own = table[scope.ext];
      if (!own || !(scope.key in own)) return;
      delete own[scope.key];
      if (Object.keys(own).length === 0) delete table[scope.ext];
      if (Object.keys(table).length === 0) rmSync(file(), { force: true });
      else save(table);
    },
  };
}
