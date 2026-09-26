/**
 * Desktop IPC calls for importing a Chrome profile into a Band browser
 * profile. Handlers live in `apps/desktop/src/browser/chrome-import/`.
 *
 * Only call these after the user agreed to let Band read Chrome data.
 * Cookie values stay in the desktop process; the renderer gets counts.
 */

import { invoke } from "./desktop-ipc";

export interface ChromeProfile {
  directory: string;
  name: string;
}

export interface ChromeImportSummary {
  imported: number;
  rejected: number;
  skippedGoogle: number;
  skippedPartitioned: number;
  skippedExpired: number;
  undecryptable: number;
  total: number;
}

export function listChromeProfiles(): Promise<{ supported: boolean; profiles: ChromeProfile[] }> {
  return invoke("browser_chrome_profiles");
}

export function importChromeProfile(
  profileId: string,
  chromeProfileDirectory: string,
): Promise<ChromeImportSummary> {
  return invoke("browser_chrome_import", { profileId, chromeProfileDirectory });
}

export function clearBrowserProfileData(profileId: string): Promise<void> {
  return invoke("browser_profile_clear_data", { profileId });
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
