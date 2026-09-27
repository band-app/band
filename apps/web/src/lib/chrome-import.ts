/**
 * Desktop IPC calls for importing a Chrome profile's cookies and history.
 * Handlers live in `apps/desktop/src/browser/chrome-import/`.
 *
 * Only the import dialog calls the Chrome ones. Cookie values stay in the
 * desktop process; the renderer gets counts. History entries come back so
 * the dialog can store them with `history.import`.
 */

import { invoke } from "./desktop-ipc";

export interface ChromeProfile {
  directory: string;
  name: string;
}

export interface ChromeCookieSummary {
  imported: number;
  rejected: number;
  skippedGoogle: number;
  skippedPartitioned: number;
  skippedExpired: number;
  undecryptable: number;
  total: number;
}

export interface ChromeHistoryEntry {
  url: string;
  title: string | null;
  visitCount: number;
  lastVisitedAt: number;
}

export interface ChromeImportResult {
  /** `null` when cookies weren't selected. */
  cookies: ChromeCookieSummary | null;
  /** `null` when history wasn't selected. */
  history: ChromeHistoryEntry[] | null;
}

export interface ChromeImportOptions {
  /** Band profile to import cookies into. */
  profileId: string;
  chromeProfileDirectory: string;
  cookies: boolean;
  history: boolean;
}

export function listChromeProfiles(): Promise<{
  supported: boolean;
  running: boolean;
  profiles: ChromeProfile[];
}> {
  return invoke("browser_chrome_profiles");
}

export function isChromeRunning(): Promise<{ running: boolean }> {
  return invoke("browser_chrome_running");
}

/**
 * Read every selected Chrome DB, then write the cookies into `profileId`'s
 * partition. History entries come back for the caller to store.
 */
export function importChromeProfile(options: ChromeImportOptions): Promise<ChromeImportResult> {
  return invoke("browser_chrome_import", { ...options });
}

export function clearBrowserProfileData(profileId: string): Promise<void> {
  return invoke("browser_profile_clear_data", { profileId });
}

/** Wipe every profile partition on this Mac whose id is not in `keep`. */
export function pruneBrowserProfileData(keep: string[]): Promise<string[]> {
  return invoke("browser_profile_prune", { keep });
}

/**
 * Electron wraps errors thrown in the main process as
 * "Error invoking remote method 'x': Error: <message>". Keep the message.
 */
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = /Error invoking remote method '[^']+': (?:\w*Error: )?(.*)$/s.exec(raw);
  return match?.[1] ?? raw;
}
