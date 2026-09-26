/**
 * Gate every `<webview>` the dashboard window attaches.
 *
 * `will-attach-webview` fires before a guest WebContents exists, with the
 * preferences the renderer's markup asked for. It refuses a guest whose
 * partition or first `src` falls outside `guest-policy.ts`, and overwrites
 * the security preferences of the rest (no Node, sandboxed, isolated, the
 * guest preload only). `did-attach-webview` then hands the new guest to the
 * guest manager, which wires popups, the navigation allowlist and the error
 * pages before the page's first navigation can use them.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import type { BrowserGuestManager } from "../browser/guest-manager.js";
import { admitWebviewAttach, hardenGuestWebPreferences } from "../browser/guest-policy.js";
import { createLogger } from "./services/log.js";

const log = createLogger("webview-security");

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The compiled `preload/guest.cts`, next to the dashboard preload. */
function guestPreloadPath(): string {
  // dist/main/main/webview-security.js → ../../preload/preload/guest.cjs
  return resolve(__dirname, "..", "..", "preload", "preload", "guest.cjs");
}

export function installWebviewSecurity(
  mainWindow: BrowserWindow,
  guests: BrowserGuestManager,
): void {
  const preload = guestPreloadPath();
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const src = typeof params.src === "string" ? params.src : "";
    const partition = typeof webPreferences.partition === "string" ? webPreferences.partition : "";
    if (!admitWebviewAttach({ src, partition })) {
      log.warn({ partition, src: src.slice(0, 100) }, "refused webview attach");
      event.preventDefault();
      return;
    }
    hardenGuestWebPreferences(
      webPreferences as Record<string, unknown>,
      params as unknown as Record<string, unknown>,
      preload,
    );
  });
  mainWindow.webContents.on("did-attach-webview", (_event, guest) => {
    guests.attachGuest(guest);
  });
}
