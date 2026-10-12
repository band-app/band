import { safeStorage } from "electron";
import type { SecretStore } from "./secret-store.js";

/** Electron `safeStorage`: the key lives in the OS key store (the macOS Keychain). */
export const electronSecretStore: SecretStore = {
  available: () => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // On Linux, `basic_text` encrypts with a hardcoded password, which protects nothing.
    if (process.platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend();
      return backend !== "basic_text" && backend !== "unknown";
    }
    return true;
  },
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data),
};
